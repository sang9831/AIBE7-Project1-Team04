const dotenv = require("dotenv");
const { z } = require("zod");
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { PromptTemplate } = require("@langchain/core/prompts");
const { StructuredOutputParser } = require("@langchain/core/output_parsers");
const { ChatGroq } = require("@langchain/groq");

const { verifyPlaceWithKakao } = require("../ai/kakaoLocalClient");
dotenv.config();

const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const gemini = new ChatGoogleGenerativeAI({
  apiKey,
  model: "gemini-3.1-flash-lite",
  temperature: 0,
});

const gemma = new ChatGoogleGenerativeAI({
  apiKey,
  model: "gemma-4-31b-it",
  temperature: 0,
});

const groq = new ChatGroq({
  apiKey: process.env.GROQ_API_KEY,
  model: "openai/gpt-oss-120b",
  temperature: 0,
});

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
    ),
  ]);
}

const locationParser = StructuredOutputParser.fromZodSchema(
  z.object({
    is_travel_image: z
      .boolean()
      .describe(
        "이미지가 실제 야외 풍경, 건물, 자연 등 여행지나 장소와 관련된 사진이면 true, 웹사이트 스크린샷, 단순 텍스트, 무관한 실내 사물 근접샷이면 false",
      ),
    sido: z.string().describe("시/도 (예: 서울특별시, 제주특별자치도)"),
    sigungu: z.string().describe("시/군/구 (예: 종로구, 제주시)"),
    spot_name: z.string().describe("상세 명소 이름 (예: 경복궁, 성산일출봉)"),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "이미지 단서가 얼마나 명확하고 확실한지 기반으로 한 신뢰도 점수 (0.0 ~ 1.0). 랜드마크가 확실하면 높게, 모호하면 낮게 설정하세요.",
      ),
  }),
);

const verificationParser = StructuredOutputParser.fromZodSchema(
  z.object({
    is_matching: z
      .boolean()
      .describe(
        "이미지 분석 결과와 유저 힌트가 '확정적이고 명백하게' 충돌할 때만 false를 반환하세요. 유저가 헷갈려하거나 의문문을 쓰거나, '드라마 촬영지'처럼 모호하지만 충돌하지 않는 단서를 준 경우에는 무조건 true를 반환해야 합니다.",
      ),
    final_location: z
      .string()
      .describe(
        "최종 결정된 행정구역 포함 장소명. 힌트가 거짓말이거나 헷갈려하는 상태면 [사진 분석 결과]의 장소를 그대로 적고, 힌트가 확실하게 장소를 구체화(예: 동탄호수공원 + '루나쇼 하는 곳')해 준 경우에만 힌트를 조합한 장소명을 적으세요.",
      ),
    reason: z.string().describe("일치/모순/허용 여부를 판단한 구체적인 이유"),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "분석 결과에 대한 신뢰도 점수 (0.0 ~ 1.0). 이미지 단서가 명확할수록 높게, 불명확할수록 낮게 설정하세요.",
      ),
  }),
);

const moodParser = StructuredOutputParser.fromZodSchema(
  z.object({
    terrain: z.string(),
    weather: z.string(),
    color: z.string(),
    mood: z.string(),
  }),
);

const recommendationSchema = z.object({
  spots: z.array(
    z.object({
      name: z.string().describe("지도 앱에서 검색할 명소 고유 명칭"),
      region: z.string().describe("시/도 + 시/군/구 행정구역"),
      reason: z.string().describe("추천 사유"),
    }),
  ),
});

function readModelText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  return String(content || "");
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1).trim();
  }

  return text.trim();
}

function normalizeBase64Input(input) {
  if (typeof input !== "string") return "";

  const commaIndex = input.indexOf(",");
  if (input.startsWith("data:") && commaIndex >= 0) {
    return input.slice(commaIndex + 1);
  }

  return input;
}

async function analyzeAndVerifyLocation(base64Image, userHint = "") {
  const step1Template = `
당신은 이미지 분석 전문가입니다. 주어진 사진만 보고 촬영된 여행지를 추정하세요.
텍스트 힌트보다 이미지의 시각적 단서가 무조건 1순위 우선순위를 가진다.

⚠️ [매우 중요] 만약 이미지가 여행지나 풍경 사진이 아니고, 인터넷 웹사이트 스크린샷, 컴퓨터 UI, 글자만 있는 문서, 혹은 장소를 알 수 없는 단순 사물(예: 키보드, 볼펜 등)인 경우 'is_travel_image'를 반드시 false로 설정하세요.

반드시 설명 없이 주어진 JSON 스키마 형식으로만 반환하세요.
{format_instructions}
`;

  const step1Prompt = new PromptTemplate({
    template: step1Template,
    inputVariables: [],
    partialVariables: {
      format_instructions: locationParser.getFormatInstructions(),
    },
  });

  const step1Input = await step1Prompt.format({});

  const formattedImage = `data:image/jpeg;base64,${normalizeBase64Input(base64Image)}`;

  console.time("gemini-image");
  const step1Response = await withTimeout(
    gemini.invoke([
      {
        role: "user",
        content: [
          { type: "text", text: step1Input },
          {
            type: "image_url",
            image_url: {
              url: formattedImage,
            },
          },
        ],
      },
    ]),
    20000,
  );
  console.timeEnd("gemini-image");

  let imageAnalysisResult;
  try {
    const rawStep1 = readModelText(step1Response.content);
    const jsonStep1 = extractJson(rawStep1);
    imageAnalysisResult = await locationParser.parse(jsonStep1);
    if (imageAnalysisResult.is_travel_image === false) {
      return {
        success: false,
        errorType: "INVALID_IMAGE_TYPE",
        message:
          "올바른 여행지나 풍경 사진이 아닙니다. 스크린샷이나 무관한 사진은 분석할 수 없습니다.",
      };
    }
  } catch (parseError) {
    console.error("1단계 이미지 분석 파싱 실패, 기본값 대체:", parseError);
    imageAnalysisResult = {
      sido: "기록되지 않음",
      sigungu: "알 수 없음",
      spot_name: "관광 명소",
      confidence: 0.5,
    };
  }

  const detectedLocation = `${imageAnalysisResult.sido} ${imageAnalysisResult.sigungu} ${imageAnalysisResult.spot_name}`;

  if (!userHint || userHint.trim() === "") {
    return {
      success: true,
      location: detectedLocation,
      confidence: imageAnalysisResult.confidence ?? 0.75,
      message: "힌트가 없어 이미지로만 분석했습니다.",
    };
  }

  const step2Template = `
당신은 데이터 검증 전문가입니다. 
[사진 분석 결과]의 물리적 장소와 사용자가 입력한 [사용자 입력 힌트]를 비교하여, 두 정보가 '확정적으로 모순'되는지 검증하세요.

[사진 분석 결과]: {detectedLocation}
[사용자 입력 힌트]: {userHint}

⚠️ [판정 및 검증 규칙 - 필수 준수]

1. 명백한 모순 (is_matching: false 조건):
   - 이미지 속 실제 위치와 사용자가 '확정적인 어조'로 주장하는 공간적 위치/지역이 완전히 다를 때만 false로 판정합니다.
   - 예시: [사진 분석 결과]가 '63빌딩'인데 힌트가 '제주도에서 찍음'인 경우 (확정적 거짓/모순이므로 false)

2. 모순이 아닌 허용 케이스 (is_matching: true 조건 - 매우 중요):
   - 추측 및 의문문: 사용자가 "~인가? 아닌가?", "어디였지? 기억이 안 나네" 처럼 확신이 없거나 헷갈려하는 표현을 쓴 경우 모순이 아닙니다. 유저는 정답을 모르고 있으므로 힌트를 무시하고 'is_matching'을 true로 처리하세요.
   - 포괄적/모호한 단서: "드라마 촬영지", "호수공원", "이쁜 카페" 처럼 전국 어디에나 해당할 수 있는 넓은 범위의 단서를 준 경우, 이미지 결과와 충돌하지 않으므로 모순이 아닙니다. 'is_matching'을 true로 처리하세요.
   - 유도 신문 방지: 모호한 단서("드라마 촬영지") 때문에 [사진 분석 결과](동탄호수공원)를 엉뚱한 다른 유사 장소(일산호수공원)로 왜곡하거나 상상하여 바꾸지 마십시오. 시각적 단서 기반인 [사진 분석 결과]가 무조건 최우선 가중치를 가집니다.

3. final_location 작성 규칙:
   - 'is_matching'이 true이면서 유저가 헷갈려하는 경우(예: "부산인가? 다른 데인가?"): 유저 힌트를 무시하고 [사진 분석 결과] 명칭을 그대로 final_location에 작성하세요.
   - 'is_matching'이 true이면서 유저 힌트가 정확한 단서인 경우: 두 정보를 조합하여 가장 정확한 풀네임을 완성하세요.
   - 'is_matching'이 false인 경우(모순): 사용자의 힌트는 거짓 정보이므로 전달받은 [사진 분석 결과]의 명칭을 토대로 최종 위치를 강제 고정하세요.

반드시 설명 없이 주어진 JSON 스키마 형식으로만 응답하세요.
{format_instructions}
`;

  const step2Prompt = new PromptTemplate({
    template: step2Template,
    inputVariables: ["detectedLocation", "userHint"],
    partialVariables: {
      format_instructions: verificationParser.getFormatInstructions(),
    },
  });

  const step2Input = await step2Prompt.format({
    detectedLocation: detectedLocation,
    userHint: userHint,
  });

  console.time("groq-verify");
  const step2Response = await withTimeout(
    groq.invoke([{ role: "user", content: step2Input }]),
    20000,
  );
  console.timeEnd("groq-verify");

  let verificationResult;
  try {
    const rawStep2 = readModelText(step2Response.content);
    const jsonStep2 = extractJson(rawStep2);
    verificationResult = await verificationParser.parse(jsonStep2);
  } catch (parseError) {
    console.error("2단계 검증 결과 파싱 실패, 기본 패스 처리:", parseError);
    verificationResult = {
      is_matching: true,
      final_location: detectedLocation,
      reason:
        "LLM 출력 파싱에 실패하여 이미지 기반 정보로 안전하게 대체합니다.",
    };
  }
  console.log("verificationResult:", verificationResult);

  if (!verificationResult.is_matching) {
    return {
      success: false,
      errorType: "CONTRADICTORY_INPUT",
      message: "업로드한 사진과 입력하신 힌트 장소가 일치하지 않습니다.",
      reason: verificationResult.reason,
      fallbackLocation: verificationResult.final_location,
    };
  }

  return {
    success: true,
    location: verificationResult.final_location,
    reason: verificationResult.reason,
    confidence: verificationResult.confidence ?? 0.7,
  };
}

async function analyzeMoodWithGemini(base64Image, extra = "") {
  const prompt = new PromptTemplate({
    template: `
사진의 분위기, 색감, 계절감, 장면의 인상을 분석해 주세요.

추가사항:
{extra}

반드시 JSON만 반환하고 schema를 지켜 주세요.

{format_instructions}
`,
    inputVariables: ["extra"],
    partialVariables: {
      format_instructions: moodParser.getFormatInstructions(),
    },
  });

  const formattedPrompt = await prompt.format({
    extra: extra || "(없음)",
  });

  const response = await gemini.invoke([
    {
      role: "user",
      content: [
        { type: "text", text: formattedPrompt },
        {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${normalizeBase64Input(base64Image)}`,
          },
        },
      ],
    },
  ]);

  const raw = readModelText(response.content);
  return moodParser.parse(extractJson(raw));
}

async function recommendTravelPlace(promptText) {
  try {
    console.time("groq-recommend");

    const response = await withTimeout(
      groq.invoke([
        {
          role: "user",
          content: [{ type: "text", text: promptText }],
        },
      ]),
      20000,
    );
    console.timeEnd("groq-recommend");

    const raw = readModelText(response.content);
    const jsonText = extractJson(raw);
    const parsed = JSON.parse(jsonText);

    // 스키마 검증 및 중복 제거
    const validated = recommendationSchema.parse(parsed);
    const seen = new Set();
    validated.spots = validated.spots.filter((spot) => {
      const key = spot.name.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return validated;
  } catch (error) {
    console.error("recommendTravelPlace failed:", error);
    return fallbackRecommendation("대한민국");
  }
}

function fallbackRecommendation(region = "알 수 없음") {
  return {
    spots: [
      {
        name: "추천 여행지",
        region,
        reason: "기본 추천 정보를 반환했습니다.",
      },
    ],
  };
}

async function findLocation(req, res, next) {
  try {
    const { image, hint } = req.body || {};

    if (!image) {
      return res.status(400).json({ error: "이미지를 먼저 업로드해 주세요." });
    }

    let historyHint = "";
    let parsed = null;

    for (let i = 0; i < 3; i += 1) {
      try {
        parsed = await analyzeAndVerifyLocation(
          image,
          `${hint || ""}\n${historyHint}`,
        );
      } catch (error) {
        console.error("analyzeAndVerifyLocation failed:", error);
        parsed = null;
      }

      if (
        parsed &&
        (parsed.success ||
          parsed.errorType === "CONTRADICTORY_INPUT" ||
          parsed.errorType === "INVALID_IMAGE_TYPE")
      ) {
        break;
      }

      historyHint += `
이전 결과가 확실하지 않았습니다.
지형, 건축물, 식생, 기후 단서를 더 보수적으로 판단해 주세요.
`;
    }

    if (
      parsed &&
      !parsed.success &&
      parsed.errorType === "CONTRADICTORY_INPUT"
    ) {
      return res.status(400).json({
        success: false,
        errorType: parsed.errorType,
        message: parsed.message,
        reason: parsed.reason,
      });
    }

    if (
      parsed &&
      !parsed.success &&
      parsed.errorType === "INVALID_IMAGE_TYPE"
    ) {
      return res.status(400).json({
        success: false,
        errorType: parsed.errorType,
        message: parsed.message,
      });
    }

    if (!parsed || !parsed.success) {
      return res.status(500).json({
        success: false,
        message: "이미지 분석 및 검증에 실패했습니다.",
      });
    }

    const safeLocation = {
      region: parsed.location,
      confidence: parsed.confidence,
    };

    const recommendation = await recommendTravelPlace(`
추정 위치:
${safeLocation.region}

당신은 대한민국 최고의 국내 여행 가이드입니다.
제시된 조건을 바탕으로, 카카오맵/네이버 지도에서 '실제 검색 및 위치 조회가 가능한' 한국의 구체적인 여행지 7곳을 추천해 주세요.

⚠️ [필수 준수 규칙 - 위반 시 에러]
1. 존엄성 및 실존 주의:
   - 절대로 가상의 장소, 미사여구로 꾸며낸 장소를 지어내지 마십시오. (X: "낭만적인 부산 밤바다 거리", "조용한 제주 돌담길")
   - 반드시 지도 앱에 등록되어 있는 실제 상호명, 공공 관광지명, 명소 고유 명사만 사용하십시오. (O: "광안리해수욕장", "감천문화마을", "신창풍차해안도로")

2. 추천 단위 제한:
   - "부산 영도구", "제주 서귀포시" 같은 행정구역 자체를 name에 넣지 마십시오. 반드시 구체적인 명소여야 합니다.

3. 데이터 매핑 규칙:
   - "name": 지도 앱에 검색할 '최종 목적지 고유 명칭'만 명확히 작성 (예: "해운대 블루라인파크")
   - "region": 해당 명소가 위치한 '시/도 + 시/군/구'까지 정확한 행정구역 작성 (예: "부산광역시 해운대구")
   - "reason": 왜 이 장소를 추천하는지 이유를 간결하게 작성해 주세요

4. 명소 명칭의 무단 축약 및 변형 금지 (매우 중요):
- 인터넷 검색 및 지도 앱에 등록된 '정식 풀네임(Official Full Name)'을 그대로 적으십시오.
- 접미사(호수, 저수지, 해수욕장, 평야, 생태공원 등)를 절대로 마음대로 생략하거나 축약하지 마십시오.
- 예시 오류 교정:
  * (X) 반월호 -> (O) 반월호수
  * (X) 백운호 -> (O) 백운호수
  * (X) 광안리 -> (O) 광안리해수욕장
  * (X) 일산공원 -> (O) 일산호수공원
- 지형이나 상호명의 끝 글자 하나가 달라지면 지도 API가 장소를 찾지 못하므로, 반드시 정확한 풀네임인지 검증 후 출력하세요.

5. 국가 및 행정 기관 건물 추천 배제 (매우 중요):
   - 순수한 관광 목적이 아닌 공공 행정 기관, 국가 건물, 지방 자치 단체 청사는 **절대로** 추천하지 마십시오.
   - 예시 오류 교정: (X) 서울시청, 부산시청, 제주도청, 종로구청, 울릉군청 등 모든 형태의 시청/도청/구청/군청/주민센터/정부청사 및 법원 등 공공 업무 시설은 제외합니다. 다만, 역사적 가치가 있어 관광지화된 장소(예: '구 서울역사', '덕수궁 석조전')는 허용됩니다.


출력 전 반드시 자가검증:
- [ ] 이 장소를 카카오맵에 검색하면 나오는가?
- [ ] 공식 명칭 전체를 사용했는가?
- [ ] 미사여구나 수식어가 name 필드에 없는가?
검증 실패 시 다른 장소로 교체할 것.

반드시 아래 JSON 포맷 표준을 준수하여 JSON 데이터만 반환하세요. 다른 텍스트는 절대 포함하지 마십시오.

{
  "spots": [
    {
      "name": "명소 고유 명칭",
      "region": "행정구역명",
      "reason": "추천 사유 설명"
    }
  ]
}
`);

    const validSpots = [];

    const filteredSpots = recommendation.spots.filter((spot) => {
      return (
        !safeLocation.region.includes(spot.name) &&
        !spot.name.includes(safeLocation.region)
      );
    });

    for (const spot of filteredSpots) {
      if (validSpots.length >= 3) break;

      if (await verifyPlaceWithKakao(spot)) {
        validSpots.push(spot);
      }
    }

    recommendation.spots = validSpots;

    return res.json({
      source: "Gemini",
      location: safeLocation,
      recommendation:
        recommendation || fallbackRecommendation(safeLocation.region),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message,
      recommendation: fallbackRecommendation("알 수 없음"),
    });
  }
}

async function findMood(req, res, next) {
  try {
    const { image, extra } = req.body || {};

    if (!image) {
      return res.status(400).json({ error: "이미지를 먼저 업로드해 주세요." });
    }

    let moodTags = null;
    try {
      moodTags = await analyzeMoodWithGemini(image, extra || "");
    } catch (error) {
      console.error("analyzeMoodWithGemini failed:", error);
      moodTags = {
        terrain: "알 수 없음",
        weather: "알 수 없음",
        color: "알 수 없음",
        mood: "알 수 없음",
      };
    }

    const recommendation = await recommendTravelPlace(`
사진 분위기 정보:
${JSON.stringify(moodTags, null, 2)}

추가사항:
${extra || "(없음)"}

당신은 대한민국 최고의 국내 여행 가이드입니다.
제시된 조건을 바탕으로, 카카오맵/네이버 지도에서 '실제 검색 및 위치 조회가 가능한' 한국의 구체적인 여행지 7곳을 추천해 주세요.

⚠️ [필수 준수 규칙 - 위반 시 에러]
1. 존엄성 및 실존 주의:
   - 절대로 가상의 장소, 미사여구로 꾸며낸 장소를 지어내지 마십시오. (X: "낭만적인 부산 밤바다 거리", "조용한 제주 돌담길")
   - 반드시 지도 앱에 등록되어 있는 실제 상호명, 공공 관광지명, 명소 고유 명사만 사용하십시오. (O: "광안리해수욕장", "감천문화마을", "신창풍차해안도로")

2. 추천 단위 제한:
   - "부산 영도구", "제주 서귀포시" 같은 행정구역 자체를 name에 넣지 마십시오. 반드시 구체적인 명소여야 합니다.

3. 데이터 매핑 규칙:
   - "name": 지도 앱에 검색할 '최종 목적지 고유 명칭'만 명확히 작성 (예: "해운대 블루라인파크")
   - "region": 해당 명소가 위치한 '시/도 + 시/군/구'까지 정확한 행정구역 작성 (예: "부산광역시 해운대구")
   - "reason": 왜 이 장소를 추천하는지 이유를 친절하게 설명

4. 명소 명칭의 무단 축약 및 변형 금지 (매우 중요):
- 인터넷 검색 및 지도 앱에 등록된 '정식 풀네임(Official Full Name)'을 그대로 적으십시오.
- 접미사(호수, 저수지, 해수욕장, 평야, 생태공원 등)를 절대로 마음대로 생략하거나 축약하지 마십시오.
- 예시 오류 교정:
  * (X) 반월호 -> (O) 반월호수
  * (X) 백운호 -> (O) 백운호수
  * (X) 광안리 -> (O) 광안리해수욕장
  * (X) 일산공원 -> (O) 일산호수공원
- 지형이나 상호명의 끝 글자 하나가 달라지면 지도 API가 장소를 찾지 못하므로, 반드시 정확한 풀네임인지 검증 후 출력하세요.

5. 국가 및 행정 기관 건물 추천 배제 (매우 중요):
   - 순수한 관광 목적이 아닌 공공 행정 기관, 국가 건물, 지방 자치 단체 청사는 **절대로** 추천하지 마십시오.
   - 예시 오류 교정: (X) 서울시청, 부산시청, 제주도청, 종로구청, 울릉군청 등 모든 형태의 시청/도청/구청/군청/주민센터/정부청사 및 법원 등 공공 업무 시설은 제외합니다. 다만, 역사적 가치가 있어 관광지화된 장소(예: '구 서울역사', '덕수궁 석조전')는 허용됩니다.

6. 중복 추천 절대 금지 (매우 중요):
   - 대안으로 제시하는 7곳의 여행지는 반드시 서로 다른 장소여야 합니다. 
   - 동일한 명소를 이름만 바꾸거나 완전히 똑같은 장소를 절대 중복해서 배열에 넣지 마십시오.


출력 전 반드시 자가검증:
- [ ] 이 장소를 카카오맵에 검색하면 나오는가?
- [ ] 공식 명칭 전체를 사용했는가?
- [ ] 미사여구나 수식어가 name 필드에 없는가?
검증 실패 시 다른 장소로 교체할 것.

반드시 아래 JSON 포맷 표준을 준수하여 JSON 데이터만 반환하세요. 다른 텍스트는 절대 포함하지 마십시오.

{
  "spots": [
    {
      "name": "명소 고유 명칭",
      "region": "행정구역명",
      "reason": "추천 사유 설명(간략하게)"
    }
  ]
}
`);

    const validSpots = [];
    console.log("-----------------");
    console.log(recommendation.spots);
    console.log("-----------------");

    console.log("AI 추천 원본 목록:", recommendation.spots); // 이 로그를 심어 실제로 카카오 검증 전 목록을 확인해보세요.
    for (const spot of recommendation.spots) {
      if (validSpots.length >= 3) break;

      if (await verifyPlaceWithKakao(spot)) {
        validSpots.push(spot);
      } else {
        console.log(`카카오 맵 검증 실패로 제외된 장소: ${spot.name}`);
      }
    }

    for (const spot of recommendation.spots) {
      if (validSpots.length >= 3) break;

      if (await verifyPlaceWithKakao(spot)) {
        validSpots.push(spot);
      }
    }

    recommendation.spots = validSpots;
    return res.json({
      moodTags,
      recommendation,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message,
      recommendation: fallbackRecommendation("알 수 없음"),
    });
  }
}

module.exports = {
  findLocation,
  findMood,
};
