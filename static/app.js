const state = {
  items: [],
  filteredItems: [],
  renderCount: 0,
  selected: new Set(),
  expanded: new Set(),
  castByKey: {},
  loadingCast: new Set(),
  lastSelectedKey: null,
  filters: {
    storageRoot: "",
    rootFolder: "",
    type: "",
    title: "",
    path: "",
    genres: [],
    availability: "not_empty",
  },
  sort: {
    field: "diskSize",
    direction: "desc",
  },
};

const STORAGE_KEY = "trimrr-ui-state";
const INITIAL_RENDER_COUNT = 80;
const RENDER_INCREMENT = 80;

const elements = {
  rootFolderFilter: document.getElementById("rootFolderFilter"),
  storageRootFilter: document.getElementById("storageRootFilter"),
  typeFilter: document.getElementById("typeFilter"),
  titleSearch: document.getElementById("titleSearch"),
  pathSearch: document.getElementById("pathSearch"),
  availabilityFilter: document.getElementById("availabilityFilter"),
  genreFilter: document.getElementById("genreFilter"),
  sortField: document.getElementById("sortField"),
  sortDirection: document.getElementById("sortDirection"),
  results: document.getElementById("results"),
  resultsFooter: document.getElementById("resultsFooter"),
  loadMoreButton: document.getElementById("loadMoreButton"),
  renderedCount: document.getElementById("renderedCount"),
  bulkBar: document.getElementById("bulkBar"),
  selectedCount: document.getElementById("selectedCount"),
  selectedSize: document.getElementById("selectedSize"),
  visibleCount: document.getElementById("visibleCount"),
  visibleSize: document.getElementById("visibleSize"),
  statusMessage: document.getElementById("statusMessage"),
  confirmDialog: document.getElementById("confirmDialog"),
  confirmSummary: document.getElementById("confirmSummary"),
  confirmActionButton: document.getElementById("confirmActionButton"),
};

let loadMoreObserver;

function formatBytes(value) {
  const size = Number(value) || 0;
  if (!size) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const amount = size / 1024 ** exponent;
  return `${amount.toFixed(amount >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatRatingValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric > 10) {
    return `${Math.round(numeric)}%`;
  }
  return `${numeric.toFixed(1)}/10`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(message, isError = false) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.classList.toggle("error", isError);
}

function getItemUrl(item) {
  if (!item.itemPort || !item.itemPath) {
    return "#";
  }
  const protocol = window.location.protocol || "http:";
  const hostname = window.location.hostname || "127.0.0.1";
  return `${protocol}//${hostname}:${item.itemPort}${item.itemPath}`;
}

function saveUiState() {
  const payload = {
    filters: state.filters,
    sort: state.sort,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadUiState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.filters) {
      state.filters = {
        ...state.filters,
        ...saved.filters,
        genres: Array.isArray(saved.filters.genres) ? saved.filters.genres : [],
        availability: ["not_empty", "empty", "all"].includes(saved.filters.availability) ? saved.filters.availability : "not_empty",
      };
    }
    if (saved.sort?.field) {
      state.sort.field = saved.sort.field;
    }
    if (saved.sort?.direction === "asc" || saved.sort?.direction === "desc") {
      state.sort.direction = saved.sort.direction;
    }
  } catch (error) {
    console.error("Failed to load saved UI state", error);
  }
}

function syncControlsFromState() {
  elements.rootFolderFilter.value = state.filters.rootFolder;
  elements.storageRootFilter.value = state.filters.storageRoot;
  elements.typeFilter.value = state.filters.type;
  elements.titleSearch.value = state.filters.title;
  elements.pathSearch.value = state.filters.path;
  elements.availabilityFilter.value = state.filters.availability;
  elements.sortField.value = state.sort.field;
  elements.sortDirection.dataset.direction = state.sort.direction;
  elements.sortDirection.textContent = state.sort.direction === "asc" ? "Ascending" : "Descending";
  Array.from(elements.genreFilter.options).forEach((option) => {
    option.selected = state.filters.genres.includes(option.value.toLowerCase());
  });
}

function getSelectedItems() {
  return state.items.filter((item) => state.selected.has(item.key));
}

function getRenderedItems() {
  return state.filteredItems.slice(0, state.renderCount);
}

function getVisibleItemKeys() {
  return state.filteredItems.map((item) => item.key);
}

function setRangeSelection(targetKey, checked) {
  const visibleKeys = getVisibleItemKeys();
  const endIndex = visibleKeys.indexOf(targetKey);
  const startIndex = visibleKeys.indexOf(state.lastSelectedKey);

  if (startIndex === -1 || endIndex === -1) {
    return;
  }

  const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
  for (let index = from; index <= to; index += 1) {
    const key = visibleKeys[index];
    if (checked) {
      state.selected.add(key);
    } else {
      state.selected.delete(key);
    }
  }
}

function getSelectedGenreValues() {
  return Array.from(elements.genreFilter.selectedOptions).map((option) => option.value);
}

function getCastMarkup(item) {
  if (!state.expanded.has(item.key)) {
    return "";
  }

  if (state.loadingCast.has(item.key)) {
    return `
      <section class="cast-panel">
        <div class="cast-heading">Cast</div>
        <p class="cast-empty">Loading cast...</p>
      </section>
    `;
  }

  const cast = state.castByKey[item.key] || [];
  if (!cast.length) {
    return `
      <section class="cast-panel">
        <div class="cast-heading">Cast</div>
        <p class="cast-empty">No cast photos found for this item.</p>
      </section>
    `;
  }

  const castCards = cast.map((actor) => `
    <article class="cast-card">
      ${actor.image
        ? `<img class="cast-photo" src="${escapeHtml(actor.image)}" alt="${escapeHtml(actor.name)}" loading="lazy" referrerpolicy="no-referrer">`
        : `<div class="cast-photo cast-photo-fallback">No Photo</div>`}
      <div class="cast-copy">
        <strong>${escapeHtml(actor.name)}</strong>
        <span>${escapeHtml(actor.character || "Cast")}</span>
      </div>
    </article>
  `).join("");

  return `
    <section class="cast-panel">
      <div class="cast-heading">Cast</div>
      <div class="cast-grid">${castCards}</div>
    </section>
  `;
}

function getRatingsMarkup(item) {
  const ratings = item.ratings || {};
  const audience = ratings.audience;
  const critic = ratings.critic;
  const chips = [];

  if (audience?.value != null) {
    chips.push(`<span class="meta-pill rating-pill"><strong>Audience</strong> ${escapeHtml(formatRatingValue(audience.value) || "")} <em>${escapeHtml(audience.label || "")}</em></span>`);
  }

  if (critic?.value != null) {
    chips.push(`<span class="meta-pill rating-pill"><strong>Critic</strong> ${escapeHtml(formatRatingValue(critic.value) || "")} <em>${escapeHtml(critic.label || "")}</em></span>`);
  }

  return chips.join("");
}

function getActionLabel(action) {
  if (action === "delete_files_only") return "Delete files only";
  if (action === "remove_and_delete_collection") return "Remove + delete collection";
  return "Remove + delete files";
}

function getCollectionItems(item) {
  if (item.source !== "radarr" || !item.collection?.tmdbId) {
    return [];
  }
  return state.items
    .filter((entry) => entry.source === "radarr" && entry.collection?.tmdbId === item.collection.tmdbId)
    .sort((left, right) => String(left.title).localeCompare(String(right.title), undefined, { sensitivity: "base" }));
}

function getConfirmationMarkup(action, items) {
  const totalSize = items.reduce((total, item) => total + (Number(item.diskSize) || 0), 0);
  const actionLabel = getActionLabel(action);
  const titlesMarkup = action === "remove_and_delete_collection"
    ? `<div class="confirm-titles"><strong>Titles to delete</strong><ul>${items.map((item) => `<li>${escapeHtml(item.title)}${item.year ? ` (${escapeHtml(item.year)})` : ""}</li>`).join("")}</ul></div>`
    : "";

  return {
    actionLabel,
    markup: `<p>${escapeHtml(actionLabel)} for ${items.length} item(s), totaling ${escapeHtml(formatBytes(totalSize))}.</p>${titlesMarkup}`,
  };
}

function itemMatchesFilters(item) {
  if (state.filters.storageRoot && item.storageRoot !== state.filters.storageRoot) return false;
  if (state.filters.rootFolder && item.rootFolder !== state.filters.rootFolder) return false;
  if (state.filters.type && item.type !== state.filters.type) return false;
  if (state.filters.title && !item.title.toLowerCase().includes(state.filters.title)) return false;
  if (state.filters.path && !item.path.toLowerCase().includes(state.filters.path)) return false;
  if (state.filters.availability === "not_empty" && !(Number(item.diskSize) > 0)) return false;
  if (state.filters.availability === "empty" && Number(item.diskSize) > 0) return false;
  if (state.filters.genres.length > 0) {
    const itemGenres = new Set((item.genres || []).map((genre) => genre.toLowerCase()));
    const hasAllGenres = state.filters.genres.every((genre) => itemGenres.has(genre));
    if (!hasAllGenres) return false;
  }
  return true;
}

function compareValues(left, right, field) {
  if (field === "diskSize" || field === "year") {
    return (Number(left[field]) || 0) - (Number(right[field]) || 0);
  }
  if (field === "added") {
    return (Date.parse(left.added || "") || 0) - (Date.parse(right.added || "") || 0);
  }
  return String(left[field] || "").localeCompare(String(right[field] || ""), undefined, { sensitivity: "base" });
}

function applyFiltersAndSort() {
  state.filteredItems = state.items
    .filter(itemMatchesFilters)
    .sort((left, right) => {
      const direction = state.sort.direction === "asc" ? 1 : -1;
      return compareValues(left, right, state.sort.field) * direction;
    });
  state.renderCount = Math.min(INITIAL_RENDER_COUNT, state.filteredItems.length);
  render();
}

function loadMoreItems() {
  if (state.renderCount >= state.filteredItems.length) {
    return;
  }
  state.renderCount = Math.min(state.renderCount + RENDER_INCREMENT, state.filteredItems.length);
  render();
}

function updateSelectionUi() {
  const selectedItems = getSelectedItems();
  const selectedSize = selectedItems.reduce((total, item) => total + (Number(item.diskSize) || 0), 0);
  elements.bulkBar.classList.toggle("hidden", selectedItems.length === 0);
  elements.selectedCount.textContent = `${selectedItems.length} selected`;
  elements.selectedSize.textContent = formatBytes(selectedSize);
}

function render() {
  const visibleSize = state.filteredItems.reduce((total, item) => total + (Number(item.diskSize) || 0), 0);
  const renderedItems = getRenderedItems();
  elements.visibleCount.textContent = String(state.filteredItems.length);
  elements.visibleSize.textContent = formatBytes(visibleSize);

  if (state.filteredItems.length === 0) {
    elements.results.innerHTML = "";
    elements.resultsFooter.classList.add("hidden");
    setStatus("No items match the current filters.");
    updateSelectionUi();
    return;
  }

  const moreRemaining = state.filteredItems.length - renderedItems.length;
  setStatus(`Showing ${renderedItems.length} of ${state.filteredItems.length} items${moreRemaining > 0 ? `, ${moreRemaining} more waiting` : ""}.`);
  elements.results.innerHTML = renderedItems.map((item) => {
    const year = item.year ? ` (${item.year})` : "";
    const poster = item.poster
      ? `<img class="poster" src="${item.poster}" alt="${escapeHtml(item.title)} poster" loading="lazy">`
      : `<div class="poster poster-fallback">No Poster</div>`;
    const genres = (item.genres || []).map((genre) => `<span class="tag">${escapeHtml(genre)}</span>`).join("");
    const typeLabel = item.type === "movie" ? "Movie" : "TV";
    const isExpanded = state.expanded.has(item.key);
    const collectionItems = getCollectionItems(item);
    return `
      <article class="result-card ${isExpanded ? "expanded" : ""}" data-key="${item.key}">
        <div class="select-cell">
          <input type="checkbox" class="item-select" data-key="${item.key}" ${state.selected.has(item.key) ? "checked" : ""}>
        </div>
        <div class="poster-cell">${poster}</div>
        <div class="content-cell">
          <div class="card-topline">
            <h3>${escapeHtml(item.title)}${escapeHtml(year)}</h3>
            <a class="source-pill ${item.source}" href="${escapeHtml(getItemUrl(item))}" target="_blank" rel="noopener noreferrer">${item.source}</a>
          </div>
          <div class="meta-row">
            <span class="meta-pill">${typeLabel}</span>
            <span class="meta-pill">${formatBytes(item.diskSize)}</span>
            <span class="meta-pill">${escapeHtml(item.rootFolder || "No root folder")}</span>
            ${getRatingsMarkup(item)}
          </div>
          <div class="genres-row">${genres || '<span class="tag muted">No genres</span>'}</div>
          <p class="path-line">${escapeHtml(item.path || "No path")}</p>
          <p class="overview">${escapeHtml(item.overview || "No description available.")}</p>
          ${getCastMarkup(item)}
        </div>
        <div class="action-cell">
          <button type="button" class="danger-button row-action" data-action="delete_files_only" data-key="${item.key}" ${item.hasFiles ? "" : "disabled"}>Delete files only</button>
          <button type="button" class="danger-button solid row-action" data-action="remove_and_delete" data-key="${item.key}">Remove + delete files</button>
          ${collectionItems.length > 0 ? `<button type="button" class="danger-button collection-action row-action" data-action="remove_and_delete_collection" data-key="${item.key}">Remove + delete collection</button>` : ""}
        </div>
      </article>
    `;
  }).join("");

  elements.resultsFooter.classList.toggle("hidden", renderedItems.length >= state.filteredItems.length);
  elements.renderedCount.textContent = `Showing ${renderedItems.length} of ${state.filteredItems.length}`;
  updateSelectionUi();
}

function populateFilters(rootFolders, storageRoots, genres) {
  elements.storageRootFilter.innerHTML = `<option value="">All</option>${storageRoots.map((root) => `<option value="${escapeHtml(root)}">${escapeHtml(root)}</option>`).join("")}`;
  elements.rootFolderFilter.innerHTML = `<option value="">All</option>${rootFolders.map((folder) => `<option value="${escapeHtml(folder)}">${escapeHtml(folder)}</option>`).join("")}`;
  elements.genreFilter.innerHTML = genres.map((genre) => `<option value="${escapeHtml(genre)}">${escapeHtml(genre)}</option>`).join("");
  syncControlsFromState();
}

async function loadItems() {
  setStatus("Loading library data...");
  const response = await fetch("/api/items");
  if (!response.ok) {
    throw new Error(`Failed to load items: ${response.status}`);
  }
  const payload = await response.json();
  state.items = payload.items || [];
  populateFilters(payload.rootFolders || [], payload.storageRoots || [], payload.genres || []);
  applyFiltersAndSort();
}

async function confirmAndRunAction(action, items) {
  if (!items.length) return;

  const { actionLabel, markup } = getConfirmationMarkup(action, items);
  elements.confirmSummary.innerHTML = markup;
  elements.confirmActionButton.textContent = actionLabel;

  elements.confirmDialog.showModal();
  const choice = await new Promise((resolve) => {
    elements.confirmDialog.addEventListener("close", () => resolve(elements.confirmDialog.returnValue), { once: true });
  });

  if (choice !== "confirm") return;

  setStatus(`Running ${actionLabel.toLowerCase()}...`);
  const response = await fetch("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, items }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Action failed with ${response.status}`);
  }

  const targetKeys = new Set(items.map((item) => item.key));

  if (action === "remove_and_delete" || action === "remove_and_delete_collection") {
    state.items = state.items.filter((item) => !targetKeys.has(item.key));
    targetKeys.forEach((key) => {
      state.selected.delete(key);
      state.expanded.delete(key);
      state.loadingCast.delete(key);
      delete state.castByKey[key];
    });
  } else {
    state.items = state.items.map((item) => (
      targetKeys.has(item.key)
        ? { ...item, diskSize: 0, hasFiles: false }
        : item
    ));
  }

  setStatus(`Completed ${actionLabel.toLowerCase()} for ${items.length} item(s).`);
  applyFiltersAndSort();
}

async function loadCast(item) {
  state.loadingCast.add(item.key);
  render();

  try {
    const response = await fetch(`/api/cast?source=${encodeURIComponent(item.source)}&id=${encodeURIComponent(item.id)}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `Failed to load cast: ${response.status}`);
    }
    if (state.expanded.has(item.key)) {
      state.castByKey[item.key] = payload.cast || [];
    }
  } catch (error) {
    if (state.expanded.has(item.key)) {
      state.castByKey[item.key] = [];
    }
    console.error(error);
  } finally {
    state.loadingCast.delete(item.key);
    render();
  }
}

function toggleExpanded(item) {
  if (state.expanded.has(item.key)) {
    state.expanded.delete(item.key);
    delete state.castByKey[item.key];
    state.loadingCast.delete(item.key);
    render();
    return;
  }

  state.expanded.add(item.key);
  render();
  loadCast(item);
}

function bindEvents() {
  elements.storageRootFilter.addEventListener("change", (event) => {
    state.filters.storageRoot = event.target.value;
    saveUiState();
    applyFiltersAndSort();
  });
  elements.rootFolderFilter.addEventListener("change", (event) => {
    state.filters.rootFolder = event.target.value;
    saveUiState();
    applyFiltersAndSort();
  });
  elements.typeFilter.addEventListener("change", (event) => {
    state.filters.type = event.target.value;
    saveUiState();
    applyFiltersAndSort();
  });
  elements.titleSearch.addEventListener("input", (event) => {
    state.filters.title = event.target.value.trim().toLowerCase();
    saveUiState();
    applyFiltersAndSort();
  });
  elements.pathSearch.addEventListener("input", (event) => {
    state.filters.path = event.target.value.trim().toLowerCase();
    saveUiState();
    applyFiltersAndSort();
  });
  elements.availabilityFilter.addEventListener("change", (event) => {
    state.filters.availability = event.target.value;
    saveUiState();
    applyFiltersAndSort();
  });
  elements.genreFilter.addEventListener("change", () => {
    state.filters.genres = getSelectedGenreValues().map((value) => value.toLowerCase());
    saveUiState();
    applyFiltersAndSort();
  });
  elements.sortField.addEventListener("change", (event) => {
    state.sort.field = event.target.value;
    saveUiState();
    applyFiltersAndSort();
  });
  elements.sortDirection.addEventListener("click", () => {
    state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
    elements.sortDirection.dataset.direction = state.sort.direction;
    elements.sortDirection.textContent = state.sort.direction === "asc" ? "Ascending" : "Descending";
    saveUiState();
    applyFiltersAndSort();
  });

  document.getElementById("clearFilters").addEventListener("click", () => {
    state.filters = { storageRoot: "", rootFolder: "", type: "", title: "", path: "", genres: [], availability: "not_empty" };
    elements.storageRootFilter.value = "";
    elements.rootFolderFilter.value = "";
    elements.typeFilter.value = "";
    elements.titleSearch.value = "";
    elements.pathSearch.value = "";
    elements.availabilityFilter.value = "not_empty";
    Array.from(elements.genreFilter.options).forEach((option) => { option.selected = false; });
    saveUiState();
    applyFiltersAndSort();
  });

  document.getElementById("selectVisible").addEventListener("click", () => {
    state.filteredItems.forEach((item) => state.selected.add(item.key));
    render();
  });

  document.getElementById("clearSelection").addEventListener("click", () => {
    state.selected.clear();
    render();
  });

  document.getElementById("bulkDeleteFiles").addEventListener("click", async () => {
    await confirmAndRunAction("delete_files_only", getSelectedItems());
  });
  document.getElementById("bulkRemoveDelete").addEventListener("click", async () => {
    await confirmAndRunAction("remove_and_delete", getSelectedItems());
  });
  elements.loadMoreButton.addEventListener("click", () => {
    loadMoreItems();
  });

  elements.results.addEventListener("click", (event) => {
    const checkbox = event.target.closest(".item-select");
    if (!checkbox) return;
    const key = checkbox.dataset.key;

    if (event.shiftKey && state.lastSelectedKey) {
      setRangeSelection(key, checkbox.checked);
    } else if (checkbox.checked) {
      state.selected.add(key);
    } else {
      state.selected.delete(key);
    }

    state.lastSelectedKey = key;
    render();
  });

  elements.results.addEventListener("click", async (event) => {
    const button = event.target.closest(".row-action");
    if (button) {
      const item = state.items.find((entry) => entry.key === button.dataset.key);
      if (!item) return;
      const items = button.dataset.action === "remove_and_delete_collection" ? getCollectionItems(item) : [item];
      await confirmAndRunAction(button.dataset.action, items);
      return;
    }

    if (event.target.closest(".item-select")) {
      return;
    }

    if (event.target.closest(".source-pill")) {
      return;
    }

    const card = event.target.closest(".result-card");
    if (!card) return;
    const item = state.items.find((entry) => entry.key === card.dataset.key);
    if (!item) return;
    toggleExpanded(item);
  });
}

async function init() {
  loadUiState();
  bindEvents();
  loadMoreObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        loadMoreItems();
      }
    });
  }, { rootMargin: "300px 0px" });
  loadMoreObserver.observe(elements.resultsFooter);
  try {
    await loadItems();
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Failed to initialize trimrr.", true);
  }
}

init();
