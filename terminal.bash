MATRIX_SHEETS_ENTRY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/matrix-sheets.mjs"

msheets() {
  node "$MATRIX_SHEETS_ENTRY" "$@"
}
