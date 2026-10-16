-- Tour file reading and validation. Pure: touches the filesystem only to
-- check that stop files exist and count their lines — never windows or buffers.
local M = {}

-- Which sides each view shows, in a fixed order so error messages are stable.
local VIEW_SIDES = {
  split = { "base", "head" },
  head = { "head" },
  base = { "base" },
}
local SEVERITIES = { low = true, med = true, high = true }
local KINDS = { explain = true, finding = true }

local function is_nil(v)
  return v == nil or v == vim.NIL
end

local function shows(view, side)
  for _, s in ipairs(VIEW_SIDES[view]) do
    if s == side then return true end
  end
  return false
end

--- Count the lines of a regular file; nil when missing or not a file.
function M.file_lines(path)
  local st = vim.uv.fs_stat(path)
  if not st or st.type ~= "file" then return nil end
  local n = 0
  for _ in io.lines(path) do n = n + 1 end
  return n
end

--- Absolute path of a stop's file on one side, or nil when that side has no file.
--- JSON null baseFile means "added by the PR"; an absent baseFile defaults to file.
function M.side_path(roots, stop, side)
  local rel
  if side == "head" then
    rel = stop.file
  elseif stop.baseFile == vim.NIL then
    return nil
  else
    rel = stop.baseFile
    if rel == nil then rel = stop.file end
  end
  if is_nil(rel) or type(rel) ~= "string" then return nil end
  return vim.fs.normalize(roots[side] .. "/" .. rel)
end

--- Why a note can't be shown, or nil when it is fine.
local function note_problem(note, view, counts)
  if type(note) ~= "table" then return "not an object" end
  if not shows(view, note.side) then
    return ("side '%s' is not shown by view '%s'"):format(tostring(note.side), view)
  end
  if not KINDS[note.kind] then return "unknown kind: " .. tostring(note.kind) end
  if note.kind == "finding" and not SEVERITIES[note.severity] then
    return "finding needs severity low|med|high"
  end
  if type(note.text) ~= "string" or note.text == "" then return "text is required" end
  local n = counts[note.side]
  if type(note.line) ~= "number" or note.line < 1 or note.line > n then
    return ("line %s is outside the %s file (%d lines)"):format(tostring(note.line), note.side, n)
  end
  return nil
end

--- Validate one stop. Returns the normalized stop, or nil plus the reason it was dropped.
local function validate_stop(roots, stop, i, drop)
  if type(stop) ~= "table" then return nil, "not an object" end
  if not VIEW_SIDES[stop.view] then return nil, "unknown view: " .. tostring(stop.view) end
  local paths, counts = {}, {}
  for _, side in ipairs(VIEW_SIDES[stop.view]) do
    local p = M.side_path(roots, stop, side)
    if not p then
      if stop.view == "split" and side == "base" then
        return nil, "view 'split' needs a base file (use view 'head' for added files)"
      end
      return nil, ("view '%s' needs a %s file"):format(stop.view, side)
    end
    local n = M.file_lines(p)
    if not n then return nil, ("%s file not found: %s"):format(side, p) end
    paths[side], counts[side] = p, n
  end

  local focus = stop.view == "base" and "base" or "head"
  local line = stop.line
  if type(line) ~= "number" or line < 1 or line > counts[focus] then
    return nil, ("line %s is outside the %s file (%d lines)"):format(tostring(line), focus, counts[focus])
  end
  local end_line = stop.endLine
  if is_nil(end_line) then
    end_line = line
  elseif type(end_line) ~= "number" or end_line < line then
    drop(("stop %d: endLine %s is invalid; using line %d"):format(i, tostring(end_line), line))
    end_line = line
  elseif end_line > counts[focus] then
    drop(("stop %d: endLine %d is past the end; using %d"):format(i, end_line, counts[focus]))
    end_line = counts[focus]
  end

  local notes = {}
  for j, note in ipairs(type(stop.notes) == "table" and stop.notes or {}) do
    local problem = note_problem(note, stop.view, counts)
    if problem then
      drop(("stop %d note %d dropped: %s"):format(i, j, problem))
    else
      notes[#notes + 1] = {
        side = note.side,
        line = note.line,
        kind = note.kind,
        severity = note.kind == "finding" and note.severity or nil,
        text = note.text,
      }
    end
  end

  return {
    title = type(stop.title) == "string" and stop.title or ("Stop " .. i),
    view = stop.view,
    paths = paths,
    focus = focus,
    line = line,
    endLine = end_line,
    notes = notes,
    more = type(stop.more) == "string" and stop.more or nil,
  }
end

--- Validate a decoded tour. Returns (tour, nil, dropped) or (nil, err, dropped);
--- `dropped` lists every note or stop removed, with the reason.
function M.validate(raw)
  local dropped = {}
  local function drop(msg) dropped[#dropped + 1] = msg end
  if type(raw) ~= "table" then return nil, "tour must be a JSON object", dropped end
  if raw.version ~= 1 then return nil, "unsupported tour version: " .. tostring(raw.version), dropped end
  if type(raw.headRoot) ~= "string" or type(raw.baseRoot) ~= "string" then
    return nil, "headRoot and baseRoot are required strings", dropped
  end
  if type(raw.stops) ~= "table" or #raw.stops == 0 then
    return nil, "stops must be a non-empty array", dropped
  end
  local roots = { head = vim.fs.normalize(raw.headRoot), base = vim.fs.normalize(raw.baseRoot) }
  local stops = {}
  for i, stop in ipairs(raw.stops) do
    local ok, reason = validate_stop(roots, stop, i, drop)
    if ok then
      stops[#stops + 1] = ok
    else
      drop(("stop %d dropped: %s"):format(i, reason))
    end
  end
  if #stops == 0 then return nil, "every stop was dropped", dropped end
  return { title = type(raw.title) == "string" and raw.title or "", roots = roots, stops = stops }, nil, dropped
end

--- Read and JSON-decode a tour file. Returns the raw table, or nil plus an error.
function M.read(path)
  local f = io.open(path, "r")
  if not f then return nil, "cannot read tour file: " .. tostring(path) end
  local text = f:read("*a")
  f:close()
  local ok, decoded = pcall(vim.json.decode, text)
  if not ok then return nil, "tour file is not valid JSON: " .. tostring(decoded) end
  return decoded
end

return M
