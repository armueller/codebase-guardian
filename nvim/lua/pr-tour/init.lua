-- pr-tour: renders a review tour (stops + pinned notes) handed over by the
-- scripts/pr-tour CLI, and reports where the reviewer is. Knows nothing about
-- PRs or Claude. Every entry point returns a JSON string and never throws.
local state = require("pr-tour.state")
local tour = require("pr-tour.tour")
local render = require("pr-tour.render")

local M = {}
local config = { keys = { next = "]s", prev = "[s", more = "gK" } }
local configured = false

local function define_highlights()
  vim.api.nvim_set_hl(0, "PrTourNote", { link = "Comment", default = true })
  vim.api.nvim_set_hl(0, "PrTourFinding", { link = "DiagnosticWarn", default = true })
  vim.api.nvim_set_hl(0, "PrTourFocus", { link = "CursorLine", default = true })
end

function M.setup(opts)
  config = vim.tbl_deep_extend("force", config, opts or {})
  define_highlights()
  vim.api.nvim_create_autocmd("ColorScheme", {
    group = vim.api.nvim_create_augroup("pr-tour-highlights", { clear = true }),
    callback = define_highlights,
  })
  configured = true
end

--- Run an entry point, turning any Lua error into {ok=false} JSON.
local function respond(fn, ...)
  if not configured then M.setup() end
  local ok, result = pcall(fn, ...)
  if not ok then result = { ok = false, error = tostring(result) } end
  return vim.json.encode(result)
end

local function count_findings(t)
  local n = 0
  for _, stop in ipairs(t.stops) do
    for _, note in ipairs(stop.notes) do
      if note.kind == "finding" then n = n + 1 end
    end
  end
  return n
end

local function do_load(path)
  local raw, read_err = tour.read(path)
  if not raw then return { ok = false, error = read_err, dropped = {} } end
  local t, err, dropped = tour.validate(raw)
  if not t then return { ok = false, error = err, dropped = dropped } end
  render.stop()
  state.tour = t
  state.real_roots = { base = vim.uv.fs_realpath(t.roots.base), head = vim.uv.fs_realpath(t.roots.head) }
  render.start()
  render.show(1)
  return { ok = true, title = t.title, stops = #t.stops, findings = count_findings(t), dropped = dropped }
end

function M.load(path) return respond(do_load, path) end

return M
