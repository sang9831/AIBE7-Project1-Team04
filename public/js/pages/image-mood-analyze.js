const API_BASE = "http://localhost:3000";
const SPINNER =
  '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>';

const state = {
  imageBase64: "",
  isLoading: false,
  previewUrl: "",
  requestId: 0,
};

const elements = {
  input: document.querySelector("#moodImageInput"),
  preview: document.querySelector("#moodPreview"),
  placeholder: document.querySelector("#moodPlaceholder"),
  uploadBox: document.querySelector("#moodUploadBox"),
  extra: document.querySelector("#moodExtraInput"),
  button: document.querySelector("#moodRecommendBtn"),
  status: document.querySelector("#moodStatus"),
  error: document.querySelector("#moodError"),
  interpretation: document.querySelector("#moodInterpretationResult"),
  recommendation: document.querySelector("#moodRecommendationResult"),
};

function ensureKakaoReady() {
  return new Promise((resolve) => {
    if (window.kakao && window.kakao.maps && window.kakao.maps.services) {
      resolve(window.kakao);
      return;
    }
    if (window.kakao && window.kakao.maps && window.kakao.maps.load) {
      window.kakao.maps.load(() => resolve(window.kakao));
      return;
    }
    const interval = setInterval(() => {
      if (window.kakao && window.kakao.maps && window.kakao.maps.services) {
        clearInterval(interval);
        window.kakao.maps.load(() => resolve(window.kakao));
      }
    }, 100);
  });
}

async function searchKakaoPlaces(query) {
  const kakao = await ensureKakaoReady();
  return new Promise((resolve) => {
    const places = new kakao.maps.services.Places();

    places.keywordSearch(query, (results, status) => {
      if (status === kakao.maps.services.Status.ZERO_RESULT) {
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.addressSearch(query, (addrResults, addrStatus) => {
          if (addrStatus !== kakao.maps.services.Status.OK) {
            resolve([]);
            return;
          }

          resolve(
            addrResults.map((item) => ({
              name: item.road_address?.building_name || item.address_name,
              latitude: Number(item.y),
              longitude: Number(item.x),
            })),
          );
        });
        return;
      }

      if (status !== kakao.maps.services.Status.OK) {
        resolve([]);
        return;
      }

      resolve(
        results.map((item) => ({
          name: item.place_name || item.address_name,
          latitude: Number(item.y),
          longitude: Number(item.x),
        })),
      );
    });
  });
}

async function renderKakaoCardMap(container, place) {
  const kakao = await ensureKakaoReady();
  const position = new kakao.maps.LatLng(place.latitude, place.longitude);

  const map = new kakao.maps.Map(container, {
    center: position,
    level: 3,
  });

  const marker = new kakao.maps.Marker({ position, map });
  void marker;

  map.setDraggable(false);
  map.setZoomable(false);

  setTimeout(() => {
    map.relayout();
    map.setCenter(position);
  }, 150);

  return map;
}

async function renderKakaoMaps(spots) {
  for (const [index, spot] of spots.entries()) {
    const container = document.getElementById(`map-${index}`);
    if (!container) continue;

    const searchQuery = spot.region ? `${spot.region} ${spot.name}` : spot.name;
    try {
      const results = await searchKakaoPlaces(searchQuery);
      if (results && results.length > 0) {
        const targetPlace = results[0];
        await renderKakaoCardMap(container, {
          name: spot.name,
          latitude: targetPlace.latitude,
          longitude: targetPlace.longitude,
        });
      } else {
        container.innerHTML = `
          <div class="d-flex align-items-center justify-content-center h-100 bg-light text-muted" style="font-size:12px;">
            지도 위치 검색 실패
          </div>`;
      }
    } catch (error) {
      console.error("지도 처리 실패:", error);
      container.innerHTML = `<div class="d-flex align-items-center justify-content-center h-100 bg-light text-danger" style="font-size:12px;">지도 로드 에러</div>`;
    }
  }
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(el, message, animate = false) {
  el.innerHTML = animate
    ? `<span class="status-dots">${message}</span>`
    : message;
}

function clearStatus(el) {
  el.textContent = "";
}

function showError(el, resultEl, message) {
  el.textContent = message;
  el.classList.add("visible");
  resultEl.classList.remove("visible");
  resultEl.innerHTML = "";
}

function clearError(el) {
  el.textContent = "";
  el.classList.remove("visible");
}

function friendlyError(error) {
  const msg = error?.message || String(error);

  if (
    msg.includes("Failed to fetch") ||
    msg.includes("NetworkError") ||
    msg.includes("TypeError")
  ) {
    return "서버 연결에 실패했습니다. 서버가 정상적으로 실행 중인지 확인해 주세요.";
  }
  if (msg === "413" || msg.includes("too large")) {
    return "업로드한 이미지 용량이 너무 큽니다. 더 작은 이미지로 다시 시도해 주세요.";
  }
  if (msg === "500" || msg.includes("Internal Server Error")) {
    return "서버에서 이미지를 분석하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
  }

  if (msg && msg !== "400" && isNaN(msg)) {
    return msg;
  }

  return "요청을 처리하는 동안 문제가 발생했습니다. 다시 시도해 주세요.";
}

function updatePreview(file, imageEl, placeholderEl, uploadBoxEl) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  imageEl.src = state.previewUrl;
  imageEl.classList.remove("d-none");
  placeholderEl.classList.add("d-none");
  uploadBoxEl.classList.add("has-image");
}

function configRecommendationSpots(spots) {
  sessionStorage.setItem("recommendationSpots", JSON.stringify(spots));
}

function setImageFromFile(file, imageEl, placeholderEl, uploadBoxEl, btnEl) {
  if (!file) return;

  updatePreview(file, imageEl, placeholderEl, uploadBoxEl);

  const img = new Image();
  img.src = state.previewUrl;

  img.onload = () => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const MAX_WIDTH = 1200;
    const MAX_HEIGHT = 1200;
    let width = img.width;
    let height = img.height;

    if (width > height) {
      if (width > MAX_WIDTH) {
        height *= MAX_WIDTH / width;
        width = MAX_WIDTH;
      }
    } else {
      if (height > MAX_HEIGHT) {
        width *= MAX_HEIGHT / height;
        height = MAX_HEIGHT;
      }
    }

    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height);

    const compressedBase64 = canvas.toDataURL("image/jpeg", 0.7);
    state.imageBase64 = compressedBase64.split(",")[1];
    btnEl.disabled = !state.imageBase64 || state.isLoading;
  };

  img.onerror = () => {
    console.error("이미지를 로드하는 중 오류가 발생했습니다.");
  };
}

async function renderSpots(spots) {
  if (!Array.isArray(spots) || spots.length === 0) {
    return '<p class="text-secondary mb-0">추천 결과가 없습니다.</p>';
  }

  let html = '<div class="custom-travel-container fade-up">';

  for (const [index, spot] of spots.entries()) {
    const spotName = spot.name || "추천 여행지";
    const region = spot.region || "";
    const reason = spot.reason || "";

    html += `
    <div class="custom-travel-item">
      <div class="travel-card">
        <div id="map-${index}" class="travel-map"></div>
        <div class="travel-card-body">
          <div>
            <div class="travel-card-head">
              <h4 class="travel-card-title">${escapeHtml(spotName)}</h4>
              ${region ? `<span class="travel-card-subtitle">📍 ${escapeHtml(region)}</span>` : ""}
            </div>
            <p class="travel-reason">${escapeHtml(reason)}</p>
          </div>
          <button
            type="button"
            class="btn spot-action-btn mt-auto"
            data-name="${escapeHtml(spotName)}"
            data-region="${escapeHtml(region)}"
            data-reason="${escapeHtml(reason)}"
          >
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" class="me-1">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/>
            </svg>
            여행지로 일정 만들기
          </button>
        </div>
      </div>
    </div>
    `;
  }

  html += "</div>";
  return html;
}

function renderMoodInterpretation(data) {
  const tags = data.moodTags || {};
  const lines = [];

  if (tags.terrain) lines.push(`지형: ${escapeHtml(tags.terrain)}`);
  if (tags.weather) lines.push(`날씨: ${escapeHtml(tags.weather)}`);
  if (tags.color) lines.push(`색감: ${escapeHtml(tags.color)}`);
  if (tags.mood) lines.push(`분위기: ${escapeHtml(tags.mood)}`);

  if (lines.length === 0) {
    return '<p class="text-secondary mb-0">분위기 해석 결과가 없습니다.</p>';
  }

  return `
    <div class="d-flex flex-column gap-5">
      ${lines
        .map(
          (line) => `
            <div class="mood-tag" style="display:block; width:100%;">
              ${line}
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

async function renderRecommendationResult(data) {
  if (!data.recommendation?.spots) return "";

  return `
    <div>
      <div class="section-label mb-3">추천 여행지 3곳</div>
      ${await renderSpots(data.recommendation.spots)}
    </div>
  `;
}

async function analyzeMood() {
  const extraInput = elements.extra;
  const btn = elements.button;
  const statusEl = elements.status;
  const errorEl = elements.error;
  const interpretationEl = elements.interpretation;
  const recommendationEl = elements.recommendation;
  const requestId = ++state.requestId;

  if (!state.imageBase64) {
    showError(errorEl, recommendationEl, "이미지를 먼저 업로드해 주세요");
    interpretationEl.innerHTML = "";
    return;
  }

  clearError(errorEl);
  clearStatus(statusEl);
  interpretationEl.innerHTML = "";
  recommendationEl.innerHTML = "";
  recommendationEl.classList.remove("visible");
  state.isLoading = true;
  btn.disabled = true;
  btn.innerHTML = SPINNER + "분석 중";

  const steps = ["분위기 해석 중", "추천 조건 반영 중", "여행지 추천 생성 중"];
  let idx = 0;
  setStatus(statusEl, steps[idx], true);
  const timer = setInterval(() => {
    idx = Math.min(idx + 1, steps.length - 1);
    setStatus(statusEl, steps[idx], true);
  }, 2500);

  try {
    const response = await fetch(`${API_BASE}/api/find-mood`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: state.imageBase64,
        extra: extraInput.value.trim(),
      }),
    });

    if (!response.ok) throw new Error(String(response.status));

    const data = await response.json();
    if (data.recommendation?.spots) {
      configRecommendationSpots(data.recommendation.spots);
    }

    if (requestId !== state.requestId) return;

    interpretationEl.innerHTML = renderMoodInterpretation(data);
    recommendationEl.innerHTML = await renderRecommendationResult(data);

    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await new Promise((r) => setTimeout(r, 100));

    recommendationEl.classList.add("visible");
    await renderKakaoMaps(data.recommendation?.spots || []);
    setStatus(statusEl, "분석 완료");
  } catch (error) {
    if (requestId !== state.requestId) return;
    showError(errorEl, recommendationEl, friendlyError(error));
    clearStatus(statusEl);
  } finally {
    clearInterval(timer);
    if (requestId !== state.requestId) return;
    state.isLoading = false;
    btn.disabled = !state.imageBase64;
    btn.innerHTML = "분위기 기반 여행지 추천";
  }
}

document.body.addEventListener("click", (event) => {
  const targetBtn = event.target.closest(".spot-action-btn");
  if (!targetBtn) return;

  const spot = {
    name: targetBtn.dataset.name,
    region: targetBtn.dataset.region,
    reason: targetBtn.dataset.reason,
  };

  sessionStorage.setItem("selectedSpot", JSON.stringify(spot));
  window.location.href = "/pages/itinerary-create.html";
});

elements.input.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  setImageFromFile(
    file,
    elements.preview,
    elements.placeholder,
    elements.uploadBox,
    elements.button,
  );
});

elements.button.addEventListener("click", analyzeMood);

window.addEventListener("DOMContentLoaded", () => {
  const savedImage = sessionStorage.getItem("uploadedImage");

  if (!savedImage) return;

  state.imageBase64 = savedImage;
  elements.preview.src = `data:image/jpeg;base64,${savedImage}`;
  elements.preview.classList.remove("d-none");
  elements.placeholder.classList.add("d-none");
  elements.uploadBox.classList.add("has-image");
  elements.button.disabled = false;
});

document.querySelector(".back-btn").addEventListener("click", () => {
  window.location.href = "../index.html";
});
