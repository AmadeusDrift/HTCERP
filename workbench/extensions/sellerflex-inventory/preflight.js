const InventoryFiles = (() => {
  const receiveHeaders = [
    "BIN", "Merchant SKU", "Quantity", "Disposition (GOOD/BAD)",
    "Expiration Date (DD/MM/YYYY)", "Manufacturing Date (DD/MM/YYYY)"
  ];
  const adjustHeaders = [
    "ASIN/SKU/FNSKU", "EXPIRY_DATE (dd/mm/yyyy)", "MANUFACTURING_DATE (dd/mm/yyyy)",
    "ADJUSTMENT_TYPE", "SOURCE_BIN_ID", "DESTINATION_BIN_ID",
    "SOURCE_INVENTORY_TYPE", "DESTINATION_INVENTORY_TYPE", "QUANTITY"
  ];
  const maxXml = 32 * 1024 * 1024;
  const maxReceiveRows = 3000;

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = "";
    let quoted = false;
    let closed = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else if (char === '"') {
          quoted = false;
          closed = true;
        } else {
          value += char;
        }
        continue;
      }
      if (char === '"' && !value && !closed) {
        quoted = true;
      } else if (char === ",") {
        row.push(value);
        value = "";
        closed = false;
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        row.push(value);
        rows.push(row);
        row = [];
        value = "";
        closed = false;
      } else {
        if (closed || char === '"') throw new Error("CSV 第 " + (rows.length + 1) + " 条记录的引号格式不正确。");
        value += char;
      }
    }
    if (quoted) throw new Error("CSV 有未闭合的引号。");
    if (row.length || value || closed) rows.push([...row, value]);
    return rows;
  }

  function openZip(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const u16 = index => view.getUint16(index, true);
    const u32 = index => view.getUint32(index, true);
    const records = new Map();
    let end = bytes.length - 22;
    for (; end >= Math.max(0, bytes.length - 65557); end -= 1) {
      if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
    }
    if (end < Math.max(0, bytes.length - 65557) || u16(end + 4) !== 0 || u16(end + 6) !== 0) {
      throw new Error("无法打开 XLSX，请另存为标准 .xlsx 后再试。");
    }
    let position = u32(end + 16);
    for (let index = 0; index < u16(end + 10); index += 1) {
      if (position + 46 > end || u32(position) !== 0x02014b50) {
        throw new Error("XLSX 压缩结构不完整。");
      }
      const nameLength = u16(position + 28);
      const name = new TextDecoder().decode(bytes.subarray(position + 46, position + 46 + nameLength));
      records.set(name, {
        flags: u16(position + 8), method: u16(position + 10), size: u32(position + 20),
        rawSize: u32(position + 24), offset: u32(position + 42)
      });
      position += 46 + nameLength + u16(position + 30) + u16(position + 32);
    }

    return {
      has: name => records.has(name),
      async xml(name) {
        const entry = records.get(name);
        if (!entry || entry.rawSize > maxXml || (entry.flags & 1) || entry.offset + 30 > end || u32(entry.offset) !== 0x04034b50) {
          throw new Error("无法读取 XLSX 中的工作表或模板信息。");
        }
        const start = entry.offset + 30 + u16(entry.offset + 26) + u16(entry.offset + 28);
        if (start + entry.size > end) throw new Error("XLSX 工作表数据不完整。");
        const compressed = bytes.subarray(start, start + entry.size);
        let raw = compressed;
        if (entry.method === 8) {
          const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
          raw = new Uint8Array(entry.rawSize);
          let offset = 0;
          try {
            for (;;) {
              const {done, value} = await reader.read();
              if (done) break;
              raw.set(value, offset);
              offset += value.length;
            }
          } finally {
            await reader.cancel();
          }
          if (offset !== raw.length) throw new Error("XLSX 解压后的大小与文件记录不一致。");
        } else if (entry.method !== 0 || entry.size !== entry.rawSize) {
          throw new Error("XLSX 使用了不支持的压缩格式。");
        }
        const document = new DOMParser().parseFromString(new TextDecoder().decode(raw), "application/xml");
        if (document.querySelector("parsererror")) throw new Error("XLSX 中有损坏的工作表。");
        return document;
      }
    };
  }

  async function readAdjustment(buffer) {
    const zip = openZip(buffer);
    const workbook = await zip.xml("xl/workbook.xml");
    const sheets = [...workbook.getElementsByTagNameNS("*", "sheet")];
    const sheet = sheets[0];
    if (!sheet) throw new Error("XLSX 缺少工作表。");
    const relationships = await zip.xml("xl/_rels/workbook.xml.rels");
    const id = [...sheet.attributes].find(attribute => attribute.localName === "id")?.value;
    const target = [...relationships.getElementsByTagNameNS("*", "Relationship")]
      .find(relation => relation.getAttribute("Id") === id)?.getAttribute("Target");
    if (!target) throw new Error("找不到 XLSX 第一张工作表。");
    const path = new URL(target, "https://xlsx.invalid/xl/workbook.xml").pathname.slice(1);
    const xml = await zip.xml(path);
    const shared = zip.has("xl/sharedStrings.xml") ? await zip.xml("xl/sharedStrings.xml") : null;
    const readText = element => [...(element?.getElementsByTagNameNS("*", "t") ?? [])]
      .filter(node => node.parentElement?.localName !== "rPh")
      .map(node => node.textContent).join("");
    const strings = [...(shared?.getElementsByTagNameNS("*", "si") ?? [])].map(readText);
    const data = xml.getElementsByTagNameNS("*", "sheetData")[0];
    if (!data) throw new Error("XLSX 第一张工作表缺少数据。");
    return [...data.children].map((row, index) => {
      const number = Number(row.getAttribute("r")) || index + 1;
      const values = [];
      const formulas = [];
      for (const cell of row.getElementsByTagNameNS("*", "c")) {
        const letters = cell.getAttribute("r")?.match(/^[A-Z]+/)?.[0];
        const column = letters
          ? [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1
          : values.length;
        const raw = cell.getElementsByTagNameNS("*", "v")[0]?.textContent ?? "";
        const type = cell.getAttribute("t");
        values[column] = type === "s" ? strings[Number(raw)] ?? "" : type === "inlineStr" ? readText(cell) : raw;
        if (cell.getElementsByTagNameNS("*", "f").length) formulas.push(column);
      }
      return {number, values, formulas};
    });
  }

  const meaningful = value => typeof value === "string" && value.trim() !== "";
  const positiveInteger = value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const matchesHeader = (cells, headers) => headers.every((header, index) => cells[index]?.trim() === header)
    && !cells.slice(headers.length).some(meaningful);
  const hasRecord = row => row.values.some(meaningful) || row.formulas.length > 0;

  function checkRows(rows, mode) {
    const isReceive = mode === "receive";
    const headers = isReceive ? receiveHeaders : adjustHeaders;
    const errors = [];
    let issueCount = 0;
    const report = message => {
      issueCount += 1;
      if (errors.length < 8) errors.push(message);
    };
    if (rows[0]?.number !== 1 || !matchesHeader(rows[0]?.values ?? [], headers)) {
      report("第 1 行表头和当前入口的模板不匹配，请使用页面的 Download template。");
      return {rows: 0, errors, issueCount};
    }
    const body = rows.slice(1);
    const records = body.filter(hasRecord);
    const highestRow = body.reduce((max, row) => Math.max(max, row.number), 1);
    const blankCount = highestRow - 1 - records.length;
    const spacedActions = [];
    if (records.length === 0) report("表格至少需要 1 条库存记录。");
    if (!isReceive && highestRow > 3001) report("超过 Adjustments 每份 3,000 行的限制，请拆分文件。");
    if (!isReceive && blankCount) report("工作表含 " + blankCount + " 个空白行，请删除整行后保存。");

    for (const {number, values, formulas} of records) {
      const cell = index => values[index] ?? "";
      if (values.slice(headers.length).some(meaningful)) report("第 " + number + " 行包含模板范围外的数据。");
      if (formulas.length) report("第 " + number + " 行含公式，请粘贴为值后保存。");

      if (isReceive) {
        if (values.length !== headers.length) report("第 " + number + " 条记录的列数与模板不一致。");
        if (!meaningful(cell(0)) || !meaningful(cell(1))) report("第 " + number + " 条记录缺少 BIN 或 Merchant SKU。");
        if (!positiveInteger(cell(2))) report("第 " + number + " 条记录的 Quantity 应为正整数。");
        if (!["GOOD", "BAD"].includes(cell(3))) report("第 " + number + " 条记录的 Disposition 应为 GOOD 或 BAD。");
      } else {
        if (!meaningful(cell(0)) || !meaningful(cell(4)) || !meaningful(cell(6))) {
          report("第 " + number + " 行缺少商品标识、来源库位或来源库存类型。");
        }
        if (cell(3) !== "REMOVE") {
          if (cell(3).trim() === "REMOVE") spacedActions.push(number);
          else report("第 " + number + " 行 ADJUSTMENT_TYPE 应填写 REMOVE。");
        }
        if (meaningful(cell(5)) || meaningful(cell(7))) report("第 " + number + " 行 REMOVE 应将目标库位和目标库存类型留空。");
        if (!positiveInteger(cell(8))) report("第 " + number + " 行 QUANTITY 缺失或不是正整数。");
      }
    }
    if (spacedActions.length) {
      const range = spacedActions.length === 1 ? String(spacedActions[0])
        : spacedActions[0] + "–" + spacedActions.at(-1);
      report("ADJUSTMENT_TYPE 有 " + spacedActions.length + " 行带空格（涉及第 " + range + " 行），请填写 REMOVE。");
    }
    return {rows: records.length, errors, issueCount};
  }

  async function sha256(buffer) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
    return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function splitReceive(file, rows, hash) {
    const records = rows.slice(1).filter(hasRecord);
    const csvLine = ({values}) => values.map(value => /[",\r\n]/.test(value)
      ? '"' + value.replace(/"/g, '""') + '"' : value).join(",");
    const header = csvLine(rows[0]);
    const stem = file.name.slice(0, -4).slice(0, 80);
    const total = Math.ceil(records.length / maxReceiveRows);
    const parts = [];
    for (let offset = 0; offset < records.length; offset += maxReceiveRows) {
      const index = parts.length + 1;
      const batch = records.slice(offset, offset + maxReceiveRows);
      const csv = [header, ...batch.map(csvLine), ""].join("\r\n");
      const part = new File([csv], `${stem}--${index}-of-${total}.csv`, {type: "text/csv"});
      // Distinguish identical chunks within one upload while keeping part identities stable on replay.
      const partHash = await sha256(new TextEncoder().encode(`${hash}:${index}`));
      parts.push({file: part, rows: batch.length, hash: partHash});
    }
    return parts;
  }

  async function inspect(file, mode) {
    const suffix = mode === "receive" ? ".csv" : ".xlsx";
    if (!file.name.toLowerCase().endsWith(suffix)) throw new Error("当前入口只接受 " + suffix + " 文件。");
    const buffer = await file.arrayBuffer();
    const rows = mode === "receive"
      ? parseCsv(new TextDecoder("utf-8", {fatal: true}).decode(buffer))
        .map((values, index) => ({number: index + 1, values, formulas: []}))
      : await readAdjustment(buffer);
    const result = checkRows(rows, mode);
    const hash = await sha256(buffer);
    if (mode === "receive" && !result.issueCount && result.rows > maxReceiveRows) {
      return {...result, hash, parts: await splitReceive(file, rows, hash)};
    }
    return {...result, hash};
  }
  return {inspect};
})();
