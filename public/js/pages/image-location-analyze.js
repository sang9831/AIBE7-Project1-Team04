const API_BASE = "https://aibe7-project1-team04.onrender.com/";
const SPINNER =
  '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>';

const state = {
  imageBase64: "",
  isLoading: false,
  previewUrl: "",
  requestId: 0,
};

const elements = {
  input: document.querySelector("#locationImageInput"),
  preview: document.querySelector("#locationPreview"),
  placeholder: document.querySelector("#locationPlaceholder"),
  uploadBox: document.querySelector("#locationUploadBox"),
  hint: document.querySelector("#locationHintInput"),
  button: document.querySelector("#locationRecommendBtn"),
  status: document.querySelector("#locationStatus"),
  error: document.querySelector("#locationError"),

  // 💡 [레이아웃 분할 교정] 상단 우측 영역과 하단 추천 리스트 영역 분리 매핑
  result: document.querySelector("#locationTopMapArea"),
  spotsResult: document.querySelector("#locationSpotsResult"),
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
    level: 4,
  });

  map.setDraggable(false);
  map.setZoomable(false);

  setTimeout(() => {
    map.relayout();
    map.setCenter(position);
  }, 150);

  return map;
}

async function renderKakaoMaps(spots, estimatedLocationName = null) {
  if (estimatedLocationName) {
    const estContainer = document.getElementById("estimated-map");
    if (estContainer) {
      try {
        const results = await searchKakaoPlaces(estimatedLocationName);
        if (results && results.length > 0) {
          const targetPlace = results[0];
          await renderKakaoCardMap(estContainer, {
            name: targetPlace.name,
            latitude: targetPlace.latitude,
            longitude: targetPlace.longitude,
          });
        } else {
          const fallbackLat = Number(estContainer.dataset.fallbackLat);
          const fallbackLng = Number(estContainer.dataset.fallbackLng);
          if (!isNaN(fallbackLat) && !isNaN(fallbackLng)) {
            await renderKakaoCardMap(estContainer, {
              name: estimatedLocationName,
              latitude: fallbackLat,
              longitude: fallbackLng,
            });
          }
        }
      } catch (err) {
        console.error("추정 위치 지도 렌더링 실패:", err);
      }
    }
  }

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
  if (!el) return;
  el.innerHTML = animate
    ? `<span class="status-dots">${message}</span>`
    : message;
}

function clearStatus(el) {
  if (!el) return;
  el.textContent = "";
}

function showError(el, resultEl, message) {
  if (el) {
    el.innerHTML = message.replace(/\n/g, "<br>");
    el.classList.add("visible");
  }
  // 💡 방어 코드 적용
  if (resultEl) {
    resultEl.innerHTML = `
      <div class="p-4 text-center text-danger">
        <p class="fw-bold mb-1">⚠️ 오류가 발생했습니다.</p>
        <span class="small text-secondary">${escapeHtml(message)}</span>
      </div>
    `;
  }
  if (elements.spotsResult) {
    elements.spotsResult.innerHTML =
      '<div class="text-center text-muted py-4">결과를 불러올 수 없습니다.</div>';
  }
}

function clearError(el) {
  if (!el) return;
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
    return "서버에 연결할 수 없습니다. 서버가 정상적으로 실행 중인지 확인해 주세요.";
  }
  if (msg === "413" || msg.includes("too large")) {
    return "업로드한 이미지 용량이 너무 큽니다. 더 작은 크기의 이미지로 다시 시도해 주세요.";
  }
  if (msg === "500" || msg.includes("Internal Server Error")) {
    return "서버에서 이미지를 분석하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (msg && msg !== "400" && isNaN(msg)) return msg;
  return "요청을 처리하는 동안 문제가 발생했습니다. 다시 시도해 주세요.";
}

// 💡 [하단 가로배치 스케치 반영] 추천 여행지 3곳을 밑으로 빼고 부트스트랩 3열(col-md-4) 가로 정렬
async function renderSpots(spots) {
  if (!Array.isArray(spots) || spots.length === 0) {
    return '<div class="text-center text-muted py-4">추천 결과가 없습니다.</div>';
  }

  let html = '<div class="row g-4 fade-up">';

  for (const [index, spot] of spots.entries()) {
    const spotName = spot.name || "추천 여행지";
    const region = spot.region || "";
    const reason = spot.reason || "";

    html += `
    <div class="col-12 col-md-4">
      <div class="card h-100 shadow-sm border-0 rounded-4 overflow-hidden d-flex flex-column" style="background:#white;">
        <div id="map-${index}" class="travel-map" style="height: 190px; width: 100%;"></div>
        <div class="card-body p-3 d-flex flex-column justify-content-between flex-grow-1">
          <div>
            <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
              <h5 class="fw-bold mb-0 text-dark fs-6">${escapeHtml(spotName)}</h5>
              ${region ? `<span class="badge bg-primary-subtle text-primary flex-shrink-0" style="font-size: 11px;">📍 ${escapeHtml(region)}</span>` : ""}
            </div>
            <p class="text-secondary small mb-3" style="line-height: 1.5; min-height: 4.5em; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;">
              ${escapeHtml(reason)}
            </p>
          </div>
          <button
            type="button"
            class="btn spot-action-btn btn-outline-primary btn-sm w-100 py-2 d-flex align-items-center justify-content-center"
            data-name="${escapeHtml(spotName)}"
            data-region="${escapeHtml(region)}"
            data-reason="${escapeHtml(reason)}"
          >
            이 여행지로 일정 만들기
          </button>
        </div>
      </div>
    </div>
    `;
  }

  html += "</div>";
  return html;
}

// 💡 [상단 우측 전용 마크업] 오른쪽 영역엔 '사진 속 추정 위치 지도만' 렌더링하는 전용 함수
function renderEstimatedTopCard(loc) {
  const estName = loc.region || "추정된 장소";
  return `
    <div class="fade-up d-flex flex-column h-100">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h4 class="fw-bold mb-0 text-primary fs-5">${escapeHtml(estName)}</h4>
        ${Number.isFinite(loc.confidence) ? `<span class="badge bg-success-subtle text-success">AI 매칭 신뢰도 ${loc.confidence * 100}%</span>` : ""}
      </div>
      <div id="estimated-map" class="travel-map flex-grow-1 rounded-3 border" style="min-height: 260px; width: 100%;"></div>
      <div class="mt-3">
        <button
          type="button"
          class="btn spot-action-btn btn-primary w-100 py-2"
          data-name="${escapeHtml(estName)}"
          data-region="${escapeHtml(estName)}"
          data-reason="사진 분석을 통해 역추적된 가상 좌표계 매칭 장소입니다."
        >
          📍 이 추정 위치로 일정 만들기
        </button>
      </div>
    </div>
  `;
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

// 💡 [핵심 교정부] 결과 데이터를 타겟 박스들에 각각 찢어서 매핑해주는 파이프라인 수립
async function mountLocationResult(data, resultEl, statusEl) {
  configRecommendationSpots(data.recommendation?.spots || []);

  // 1. 상단 우측 전용 영역에는 추정위치 지도 주입
  if (data.location && resultEl) {
    resultEl.innerHTML = renderEstimatedTopCard(data.location);
    resultEl.classList.add("visible");
  }

  // 2. 하단 와이드 영역에는 연관 추천지 3곳 주입
  if (data.recommendation?.spots && elements.spotsResult) {
    elements.spotsResult.innerHTML = await renderSpots(
      data.recommendation.spots,
    );
  }

  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  await new Promise((r) => setTimeout(r, 100));

  const estName = data.location?.region || null;

  // 3. 지도 인스턴스 초기화 바인딩 실행
  await renderKakaoMaps(data.recommendation?.spots || [], estName);

  setStatus(statusEl, "분석 완료");
}

function renderLocationChoice(data) {
  const imageGuess = data.imageGuess || "AI가 추정한 장소";
  const hintLocation = data.hintLocation || data.userHint || "입력하신 힌트";
  const userHint = data.userHint || "";
  const reason = data.reason || "";
  const hintLabel = userHint
    ? `${escapeHtml(hintLocation)} (입력: "${escapeHtml(userHint)}")`
    : escapeHtml(hintLocation);

  // 💡 세로로 길쭉해지는 버그를 잡기 위해 구조를 단순화하고 Bootstrap 패딩 및 여백 조정
  return `
    <div class="fade-up d-flex flex-column h-100 justify-content-center py-2">
      <div class="text-center mb-4">
        <div class="p-2 bg-warning-subtle text-warning-invert rounded-circle d-inline-block mb-2" style="width: 45px; height: 45px; line-height: 25px; font-size: 20px;">
          🤔
        </div>
        <h4 class="fw-bold text-dark fs-5 mb-2">어느 위치로 추천을 진행할까요?</h4>
        <p class="text-secondary small mb-0 px-2" style="line-height: 1.5;">
          AI 분석 결과와 입력하신 힌트가 서로 다른 장소를 가리키고 있습니다.<br>
          ${reason ? `<span class="text-primary fw-medium">💡 ${escapeHtml(reason)}</span>` : "더 정확한 추천을 위해 기준이 될 장소를 선택해 주세요."}
        </p>
      </div>

      <div class="d-flex flex-column gap-3 px-1">
        <button
          type="button"
          class="btn btn-outline-primary text-start loc-choice-btn p-3 rounded-3 shadow-sm border-2 d-flex align-items-center justify-content-between"
          data-location="${escapeHtml(imageGuess)}"
          style="transition: all 0.2s ease;"
        >
          <div>
            <span class="badge bg-primary mb-1 d-inline-block" style="font-size: 11px; padding: 4px 8px;">📷 AI 추정 기준</span>
            <div class="fw-bold text-dark fs-6 mt-1">${escapeHtml(imageGuess)}</div>
          </div>
          <span class="text-primary fs-5 fw-bold">→</span>
        </button>

        <button
          type="button"
          class="btn btn-outline-secondary text-start loc-choice-btn p-3 rounded-3 shadow-sm border-2 d-flex align-items-center justify-content-between"
          data-location="${escapeHtml(hintLocation)}"
          style="transition: all 0.2s ease;"
        >
          <div>
            <span class="badge bg-secondary mb-1 d-inline-block" style="font-size: 11px; padding: 4px 8px;">✏️ 입력 힌트 기준</span>
            <div class="fw-bold text-dark fs-6 mt-1">${hintLabel}</div>
          </div>
          <span class="text-secondary fs-5 fw-bold">→</span>
        </button>
      </div>
    </div>
  `;
}

async function confirmLocationChoice(
  location,
  statusEl,
  errorEl,
  resultEl,
  choiceContainer,
) {
  clearError(errorEl);
  setStatus(statusEl, "선택한 위치로 추천 생성 중", true);
  if (choiceContainer) {
    choiceContainer
      .querySelectorAll(".loc-choice-btn")
      .forEach((b) => (b.disabled = true));
  }

  try {
    const response = await fetch(`${API_BASE}/api/confirm-location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || String(response.status));
    }

    const data = await response.json();
    await mountLocationResult(data, resultEl, statusEl);
  } catch (error) {
    showError(errorEl, resultEl, friendlyError(error));
    clearStatus(statusEl);
  }
}

async function analyzeLocation() {
  const hintInput = elements.hint;
  const btn = elements.button;
  const statusEl = elements.status;
  const errorEl = elements.error;
  const resultEl = elements.result;
  const requestId = ++state.requestId;

  if (!state.imageBase64) {
    showError(errorEl, resultEl, "이미지를 먼저 업로드해 주세요.");
    return;
  }

  clearError(errorEl);
  clearStatus(statusEl);
  state.isLoading = true;
  btn.disabled = true;
  btn.innerHTML = SPINNER + "분석 중";

  const steps = ["이미지 분석 중", "위치 추정 중", "여행지 추천 생성 중"];
  let idx = 0;
  setStatus(statusEl, steps[idx], true);
  const timer = setInterval(() => {
    idx = Math.min(idx + 1, steps.length - 1);
    setStatus(statusEl, steps[idx], true);
  }, 2500);

  try {
    const response = await fetch(`${API_BASE}/api/find-location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: state.imageBase64,
        hint: hintInput.value.trim(),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("에러 메시지:", errorData.message);
      alert(errorData.message);
      return;
    }

    const data = await response.json();
    if (requestId !== state.requestId) return;

    // 만약 사용자의 추가 선택이 필요한 백엔드 스펙 분기 시 우측 상단 카드에 선택창 렌더링
    if (data.needsUserChoice) {
      clearInterval(timer);
      if (resultEl) {
        resultEl.innerHTML = renderLocationChoice(data);
        resultEl.classList.add("visible");
      }
      setStatus(statusEl, "선택이 필요합니다");

      if (resultEl) {
        resultEl.querySelectorAll(".loc-choice-btn").forEach((choiceBtn) => {
          choiceBtn.addEventListener("click", () => {
            confirmLocationChoice(
              choiceBtn.dataset.location,
              statusEl,
              errorEl,
              resultEl,
              resultEl,
            );
          });
        });
      }
      return;
    }

    await mountLocationResult(data, resultEl, statusEl);
  } catch (error) {
    console.log("catch 진입");
    console.log(error);
    console.log("error.message =", error.message);

    if (requestId !== state.requestId) return;
    showError(errorEl, resultEl, error.message);
    clearStatus(statusEl);
  } finally {
    clearInterval(timer);
    if (requestId !== state.requestId) return;
    state.isLoading = false;
    btn.disabled = !state.imageBase64;
    btn.innerHTML = "위치 기반 여행지 추천";
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
  sessionStorage.setItem("itineraryEntryMode", "image");
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

elements.button.addEventListener("click", analyzeLocation);

document.querySelector(".back-btn").addEventListener("click", () => {
  window.location.href = "../index.html";
});
