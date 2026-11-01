"""Initialize private server data from the saved US probe. No credentials or network."""
import argparse
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--output", type=Path, help="write seed SQL for Wrangler local D1")
    target.add_argument("--sqlite", type=Path, help="initialize a native SQLite verification database")
    args = parser.parse_args()
    workbench = Path(__file__).resolve().parents[1]
    path = (args.output or args.sqlite).resolve()
    if path.is_relative_to(workbench / "apps" / "web") or path.is_relative_to(workbench / "dist"):
        parser.error("seed data must stay outside web assets")
    extension = ".sql" if args.output else (".sqlite", ".sqlite3", ".db")
    if not path.name.lower().endswith(extension):
        parser.error("expected a private .sql, .sqlite or .db destination")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["node", str(workbench / "packages/catalog/bootstrap-cli.mjs"),
                    "--output" if args.output else "--sqlite", str(path)], check=True)


if __name__ == "__main__":
    main()
