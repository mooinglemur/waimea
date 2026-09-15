// The page: loads the runtime manifest and describes what will run. The test runner UI builds on this.

const $ = (id) => document.getElementById(id);

function setStatus(state, text) {
  $("state").className = `state${state ? ` ${state}` : ""}`;
  $("message").textContent = text;
}

async function loadManifest() {
  const response = await fetch("/manifest.json", { cache: "no-cache" });
  if (!response.ok) throw new Error(`the server isn't ready (${response.status})`);
  return response.json();
}

setStatus("running", "Loading the test runtime…");
try {
  const manifest = await loadManifest();
  const { archipelago, pyodide } = manifest;
  $("version").textContent =
    `waimea · Archipelago ${archipelago.version} (${archipelago.repository}@${archipelago.commit.slice(0, 7)}) · Pyodide ${pyodide.version}`;
  $("apworld").disabled = false;
  setStatus("", "Choose an apworld file to see the tests that will run.");
  $("apworld").addEventListener("change", () => {
    const file = $("apworld").files[0];
    if (file) setStatus("", `${file.name} (${Math.round(file.size / 1024)} KiB) selected.`);
  });
} catch (err) {
  setStatus("fail", `Couldn't load the test runtime: ${err.message}`);
}
