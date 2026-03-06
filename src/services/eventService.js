// src/service/eventService.js
const axios = require('axios');

exports.getCoordinates = async (address) => {
    // 핵심 주석: 카카오 REST API를 사용하여 주소를 좌표로 변환
    const KAKAO_API_KEY = process.env.KAKAO_REST_API_KEY; 
    const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURI(address)}`;

    try {
        const response = await axios.get(url, {
            headers: { Authorization: `KakaoAK ${KAKAO_API_KEY}` }
        });

        const document = response.data.documents[0];
        if (!document) return null;

        return {
            lat: parseFloat(document.y), // 숫자로 변환
            lng: parseFloat(document.x) 
        };
    } catch (error) {
        console.error("❌ 카카오 API 호출 실패:", error.message);
        throw new Error("Geocoding failed");
    }
};
