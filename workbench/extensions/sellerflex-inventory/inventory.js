(() => {
  const routes = {
    "/receive": {
      mode: "receive", title: "批量加库存", suffix: ".csv",
      tab: "Bulk Upload", upload: "Upload inventory file", refresh: "Refresh"
    },
    "/inventory/adjust": {
      mode: "adjust", title: "批量下架（REMOVE）", suffix: ".xlsx",
      tab: "Bulk Adjustment", upload: "Upload bulk adjustment file", refresh: "Refresh Status"
    }
  };
  const path = () => location.pathname.replace(/\/$/, "");
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const label = node => (node?.getAttribute("aria-label") || node?.textContent || "").trim().replace(/\s+/g, " ");
  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  const isButtonEnabled = button => !button.disabled && button.getAttribute("aria-disabled") !== "true";

  let panel;
  let shadow;
  let selectedRoute;
  let warehouseLabel;
  let items = [];
  let notice = "";
  let busy = false;
  let liveBusy = false;
  let verifying = false;
  let stopRequested = false;
  let pinnedWarehouse = "";

  function warehouse() {
    const candidate = [...document.querySelectorAll('nav [role="combobox"]')]
      .map(node => node.closest("button") || node)
      .find(node => visible(node) && label(node) && !/^Lang\s*:/i.test(label(node)));
    return label(candidate);
  }

  function mount(main, config) {
    panel = document.createElement("section");
    panel.id = "seller-flex-inventory-extension";
    shadow = panel.attachShadow({mode: "closed"});
    shadow.innerHTML = `
      <style>
        :host { display:block; margin:12px 0 18px; color:#182b34; font:14px system-ui,sans-serif; }
        * { box-sizing:border-box; }
        article { border:1px solid #cbd8dd; border-radius:12px; background:#f8fbfc; padding:16px; }
        header,.actions,.item { display:flex; align-items:center; justify-content:space-between; gap:12px; }
        header,.actions { flex-wrap:wrap; }
        h2 { font-size:18px; margin:0; }
        button { font:inherit; font-weight:600; cursor:pointer; border:1px solid #a8bbc3; border-radius:7px; padding:7px 12px; background:#fff; color:#182b34; }
        button:hover:not(:disabled) { border-color:#14586a; }
        button:disabled { cursor:default; opacity:.52; }
        button.primary { color:#fff; background:#155d70; border-color:#155d70; }
        .drop { margin:12px 0; border:1px dashed #a8bbc3; border-radius:7px; padding:10px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
        .drop.active { background:#e0f2f3; }
        .muted, #warehouse { color:#465e67; }
        #queue { display:grid; gap:6px; padding:0; margin:0 0 12px; list-style:none; }
        #queue:empty { display:none; }
        li { background:#fff; border:1px solid #dce6e9; border-radius:7px; padding:8px 10px; overflow-wrap:anywhere; }
        li[data-state="invalid"],li[data-state="failed"],li[data-state="partial"],li[data-state="unknown"] { border-left:3px solid #ab592c; }
        .details, #notice { color:#465e67; font-size:13px; line-height:1.55; white-space:pre-line; }
        .actions>div { display:flex; flex-wrap:wrap; gap:6px; }
        .filename { font-weight:600; }
      </style>
      <article aria-label="Seller Flex 批量库存助手">
        <header><h2 id="title"></h2><span id="warehouse"></span></header>
        <div class="drop">
          <button id="pick" type="button">选择表格</button>
          <label id="hint" class="muted"></label>
          <input id="files" type="file" tabindex="-1" multiple hidden>
        </div>
        <ul id="queue"></ul>
        <div class="actions">
          <span id="notice" role="status"></span>
          <div>
            <button id="clear" type="button">清空队列</button>
            <button id="stop" type="button" hidden>提交完当前文件后停止</button>
            <button id="start" class="primary" type="button">开始提交</button>
          </div>
        </div>
      </article>`;
    const input = shadow.getElementById("files");
    const drop = shadow.querySelector(".drop");
    input.accept = config.suffix;
    shadow.getElementById("title").textContent = config.title;
    shadow.getElementById("hint").textContent = "也可将多份 " + config.suffix + " 拖到这里";
    shadow.getElementById("pick").onclick = () => input.click();
    input.onchange = () => {
      const files = Array.from(input.files);
      input.value = "";
      void addFiles(files, config);
    };
    drop.ondragover = event => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      drop.classList.toggle("active", !busy && !verifying);
    };
    drop.ondragleave = () => drop.classList.remove("active");
    drop.ondrop = event => {
      event.preventDefault();
      event.stopPropagation();
      drop.classList.remove("active");
      void addFiles(Array.from(event.dataTransfer.files), config);
    };
    shadow.getElementById("clear").onclick = () => {
      if (busy || verifying) return;
      items = [];
      notice = "";
      render();
    };
    shadow.getElementById("stop").onclick = () => {
      stopRequested = true;
      notice = "当前文件处理结束后停止。";
      render();
    };
    shadow.getElementById("start").onclick = () => void start(config);
    main.prepend(panel);
    render();
  }

  function render() {
    if (!shadow || !panel.isConnected) return;
    const ready = items.filter(item => item.state === "ready").length;
    warehouseLabel = warehouse();
    shadow.getElementById("warehouse").textContent = warehouseLabel ? "当前仓库 " + warehouseLabel : "未识别到当前仓库";
    const queue = shadow.getElementById("queue");
    queue.replaceChildren();
    for (const item of items) {
      const entry = document.createElement("li");
      entry.dataset.state = item.state;
      const top = document.createElement("div");
      top.className = "item";
      const name = document.createElement("span");
      name.className = "filename";
      name.textContent = item.file.name;
      const status = document.createElement("span");
      status.textContent = {
        checking: "检查中", ready: (item.rows ?? 0) + " 条 · 待提交", invalid: "表格需要修改",
        duplicate: "已有提交记录", uploading: "等待 Amazon", complete: "全部成功",
        partial: "处理完成，有错误", failed: "Amazon 处理失败", unknown: "待在 Amazon 核对"
      }[item.state];
      top.append(name, status);
      entry.append(top);
      const messages = [...(item.messages ?? [])];
      if (item.sentName) messages.push("Amazon 文件名 " + item.sentName);
      if (messages.length) {
        const details = document.createElement("div");
        details.className = "details";
        details.textContent = messages.join("\n");
        entry.append(details);
      }
      queue.append(entry);
    }
    shadow.getElementById("notice").textContent = notice;
    shadow.getElementById("pick").disabled = busy || liveBusy || verifying;
    shadow.getElementById("clear").disabled = busy || liveBusy || verifying || !items.length;
    const stop = shadow.getElementById("stop");
    stop.hidden = !busy;
    stop.disabled = stopRequested;
    const startButton = shadow.getElementById("start");
    startButton.disabled = busy || liveBusy || verifying || !warehouseLabel || !ready;
    startButton.textContent = ready ? "提交 " + ready + " 份到 " + (warehouseLabel || "当前仓库") : "开始提交";
  }

  async function addFiles(files, config) {
    if (!files.length || busy || liveBusy || verifying || routes[path()] !== config) return;
    verifying = true;
    const additions = files.map(file => ({file, state: "checking"}));
    items.push(...additions);
    notice = "";
    render();
    for (const item of additions) {
      try {
        const {rows, errors, issueCount, hash, parts} = await InventoryFiles.inspect(item.file, config.mode);
        if (parts) {
          const position = items.indexOf(item);
          if (position < 0) continue;
          items.splice(position, 1, ...parts.map(part => {
            const duplicate = items.some(other => other.hash === part.hash && other.state === "ready");
            return {...part, sourceHash: hash, state: duplicate ? "duplicate" : "ready",
              messages: duplicate ? ["队列里已有相同拆分文件。"] : []};
          }));
          notice = item.file.name + " 已拆分为 " + parts.length + " 份，每份最多 3,000 条。";
          continue;
        }
        item.rows = rows;
        item.hash = hash;
        item.messages = errors;
        item.state = issueCount ? "invalid" : "ready";
        if (issueCount > errors.length) item.messages.push("另有 " + (issueCount - errors.length) + " 项问题。");
        if (!issueCount && items.some(other => other !== item && other.hash === hash && other.state === "ready")) {
          item.state = "duplicate";
          item.messages = ["队列里已有相同内容的文件。"];
        }
      } catch (error) {
        item.state = "invalid";
        item.messages = [error.message || "无法读取文件。"];
      }
    }
    verifying = false;
    render();
  }

  function assertContext(config, warehouseId) {
    if (routes[path()] !== config || warehouse() !== warehouseId) {
      throw new Error("当前页面或仓库已切换，队列已停止。");
    }
  }

  function nativeControls(config) {
    const main = document.querySelector("main");
    const button = [...(main?.querySelectorAll("button") ?? [])].find(node => visible(node) && label(node) === config.upload);
    const input = button?.parentElement?.querySelector('input[type="file"]')
      ?? main?.querySelector('input[type="file"]');
    return {main, button, input};
  }

  async function prepareUpload(config, warehouseId) {
    let {main, button, input} = nativeControls(config);
    if (!button || !input) {
      const tab = [...(main?.querySelectorAll('[role="tab"],label') ?? [])]
        .find(node => visible(node) && label(node) === config.tab);
      if (!tab) throw new Error("找不到 " + config.tab + "，请先打开批量上传页。");
      tab.click();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(250);
        assertContext(config, warehouseId);
        ({button, input} = nativeControls(config));
        if (button && input) break;
      }
    }
    if (!button || !input || !isButtonEnabled(button) || input.disabled || input.files.length) {
      throw new Error("原有上传控件暂不可用或已选有文件，请先处理页面上的文件。");
    }
    if (visibleDialog()) throw new Error("请先处理 Amazon 页面上的弹窗。");
    return input;
  }

  function visibleDialog() {
    return [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')].some(visible);
  }

  function uploadTable() {
    return [...document.querySelectorAll("main table")].find(table => {
      const headings = [...table.querySelectorAll("th")].map(label);
      return visible(table) && headings.includes("Uploaded file") && headings.includes("Status")
        && headings.some(heading => /^Errors\b/.test(heading));
    });
  }

  function resultFor(table, filename) {
    const rows = [...(table?.tBodies[0]?.rows ?? [])].filter(row => {
      const cell = row.cells[1];
      return label(cell) === filename || cell?.querySelector("button")?.title === filename
        || cell?.title === filename;
    });
    if (rows.length > 1) throw new Error("上传记录中同名结果不唯一，请在 Amazon 手动核对。");
    const cells = rows[0]?.cells;
    if (!cells) return;
    const status = label(cells[2]);
    const errorText = label(cells[3]);
    if (/^failed$/i.test(status)) return {state: "failed", messages: [errorText || "Amazon 返回 Failed。"]};
    if (!/^completed$/i.test(status)) return;
    const count = errorText.match(/^(\d[\d,]*)(?:\s|$)/)?.[1];
    if (/^(none|0)$/i.test(errorText) || (count && Number(count.replaceAll(",", "")) === 0)) {
      return {state: "complete", messages: ["Amazon 显示 Completed，错误为 0。"]};
    }
    if (count) return {state: "partial", messages: ["错误 " + count + " 条。可在 Amazon 对应记录查看明细。"]};
    return {state: "unknown", messages: ["Amazon 显示 Completed，错误数无法识别。请打开状态表核对。"]};
  }

  async function waitForResult(config, warehouseId, filename) {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      assertContext(config, warehouseId);
      const table = uploadTable();
      const result = resultFor(table, filename);
      if (result) return result;
      if (visibleDialog()) throw new Error("Amazon 显示了弹窗。请处理弹窗并核对当前文件，队列已停止。");
      const refresh = [...(table?.querySelectorAll("button") ?? [])]
        .find(node => visible(node) && isButtonEnabled(node) && label(node) === config.refresh);
      refresh?.click();
      await sleep(3500);
    }
    throw new Error("4 分钟内未能取得最终状态，请在 Amazon 状态表核对后再处理。");
  }

  async function submit(config, item, warehouseId) {
    const keyPrefix = ["sf-inventory-v1", warehouseId, config.mode, ""].join(":");
    const key = keyPrefix + item.hash;
    const originalKey = item.sourceHash ? keyPrefix + item.sourceHash : null;
    const original = originalKey ? (await SellerFlexManualStorage.get(originalKey))[originalKey] : null;
    const stored = (await SellerFlexManualStorage.get(key))[key];
    if (original || stored) {
      const prior = original || stored;
      item.state = item.sourceHash && ["unknown", "uploading"].includes(prior.state) ? "unknown" : "duplicate";
      item.sentName = prior.filename;
      item.messages = ["此仓库已有该原文件或文件分段的提交记录，请按下方文件名核对 Amazon。"];
      return;
    }
    const input = await prepareUpload(config, warehouseId);
    if (!uploadTable()) throw new Error("找不到 Amazon 上传状态表，队列已停止。");
    const suffix = "--sf-" + crypto.randomUUID().slice(0, 8);
    const stem = item.file.name.slice(0, -config.suffix.length).slice(0, 100);
    const filename = stem + suffix + config.suffix;
    const dispatch = new DataTransfer();
    dispatch.items.add(new File([item.file], filename, {type: item.file.type, lastModified: item.file.lastModified}));
    assertContext(config, warehouseId);
    const record = {filename, at: Date.now(), state: "uploading"};
    await SellerFlexManualStorage.set({[key]: record});
    try {
      assertContext(config, warehouseId);
      if (!input.isConnected || input.disabled || input.files.length || visibleDialog()) {
        throw new Error("上传控件已变化，队列已停止。");
      }
    } catch (error) {
      await SellerFlexManualStorage.remove(key);
      throw error;
    }
    item.sentName = filename;
    item.state = "uploading";
    render();
    try {
      input.files = dispatch.files;
      input.dispatchEvent(new Event("change", {bubbles: true}));
      Object.assign(item, await waitForResult(config, warehouseId, filename));
    } catch (error) {
      item.state = "unknown";
      item.messages = [error.message];
    }
    if (item.state !== "unknown" && input.isConnected && input.files[0]?.name === filename) {
      input.value = "";
    }
    await SellerFlexManualStorage.set({[key]: {...record, state: item.state}});
  }

  async function start(config) {
    if (busy || liveBusy || verifying || routes[path()] !== config) return;
    pinnedWarehouse = warehouse();
    if (!pinnedWarehouse) return;
    const job = items.filter(item => item.state === "ready");
    if (!job.length) return;
    busy = true;
    stopRequested = false;
    notice = "正在处理仓库 " + pinnedWarehouse + " 的提交队列。";
    render();
    try {
      await navigator.locks.request("seller-flex-inventory-batch", {ifAvailable: true}, async lock => {
        if (!lock) throw new Error("另一个 Seller Flex 标签页正在处理队列。");
        for (const item of job) {
          if (stopRequested) {
            notice = "队列已停止。";
            return;
          }
          assertContext(config, pinnedWarehouse);
          await submit(config, item, pinnedWarehouse);
          render();
          if (item.state === "unknown") {
            notice = "当前文件需要到 Amazon 核对，队列已停止。";
            return;
          }
        }
        notice = "队列处理完毕。";
      });
    } catch (error) {
      notice = error.message;
    } finally {
      busy = false;
      stopRequested = false;
      render();
    }
  }

  function sync() {
    const route = routes[path()];
    const main = document.querySelector("main");
    if (route !== selectedRoute && !busy && !verifying) {
      panel?.remove();
      panel = null;
      selectedRoute = route;
      items = [];
      notice = "";
    }
    if (!route || route !== selectedRoute || !main) return;
    if (!panel?.isConnected) mount(main, route);
    else if (warehouse() !== warehouseLabel) render();
  }

  globalThis.SellerFlexManualGuard = Object.freeze({
    isBusy: () => busy || verifying || items.length > 0,
    setLiveBusy: value => { liveBusy = Boolean(value); render(); }
  });
  sync();
  setInterval(sync, 500);
})();
