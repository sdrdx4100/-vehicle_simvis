// Thin fetch wrappers over the simvis REST API.

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* keep statusText */ }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  listDatasets: () => getJSON("/api/datasets"),
  meta: (id) => getJSON(`/api/datasets/${encodeURIComponent(id)}`),
  updateMapping: async (id, mapping) => {
    const res = await fetch(`/api/datasets/${encodeURIComponent(id)}/mapping`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mapping),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch { /* keep statusText */ }
      throw new Error(detail);
    }
    return res.json();
  },
  resetMapping: async (id) => {
    const res = await fetch(`/api/datasets/${encodeURIComponent(id)}/mapping`, { method: "DELETE" });
    if (!res.ok) throw new Error("failed to reset signal mapping");
    return res.json();
  },
  playback: (id, extra = []) =>
    getJSON(`/api/datasets/${encodeURIComponent(id)}/playback?extra=${encodeURIComponent(extra.join(","))}`),
  shifts: (id) => getJSON(`/api/datasets/${encodeURIComponent(id)}/shifts`),
  shiftDetail: (id, index) =>
    getJSON(`/api/datasets/${encodeURIComponent(id)}/shifts/${encodeURIComponent(index)}`),
  table: (id, offset, limit) =>
    getJSON(`/api/datasets/${encodeURIComponent(id)}/table?offset=${offset}&limit=${limit}`),
  makeDemo: async () => {
    const res = await fetch("/api/demo", { method: "POST" });
    if (!res.ok) throw new Error("demo generation failed");
    return res.json();
  },
  upload: async (file) => {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch("/api/datasets/upload", { method: "POST", body: form });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch { /* keep statusText */ }
      throw new Error(detail);
    }
    return res.json();
  },
};
