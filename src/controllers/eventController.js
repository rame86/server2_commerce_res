//src/controller/eventController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const eventService = require('../services/eventService'); // 서비스 가져오기 필수!

// 핵심 주석: 공연의 지도 정보(장소, 주소)를 조회하는 컨트롤러
exports.getEventLocation = async (req, res) => {
    const { eventId } = req.params;
    
    try {
        // [1] 데이터 조회
        const event = await prisma.events.findUnique({
            where: { event_id: parseInt(eventId) },
            include: { location: true } 
        });

        // [2] 예외 처리 (데이터가 없는 경우 먼저 체크!)
        if (!event || !event.location) {
            return res.status(404).json({ message: "해당 공연 정보를 찾을 수 없어." });
        }

        let loc = event.location;

        // [3] 좌표가 없으면 카카오 API로 채워넣기 (Lazy Loading)
        if (!loc.latitude || !loc.longitude) {
            const coords = await eventService.getCoordinates(loc.address);
            if (coords) {
                // DB 업데이트
                loc = await prisma.event_locations.update({
                    where: { event_id: loc.event_id },
                    data: { latitude: coords.lat, longitude: coords.lng }
                });
            }
        }

        // [4] 최종 응답 (딱 한 번만!)
        res.json({
            title: event.title,
            venue: loc.venue,
            address: loc.address,
            lat: loc.latitude,
            lng: loc.longitude
        });

    } catch (error) {
        console.error("❌ 지도 정보 조회 중 오류:", error.message);
        res.status(500).json({ message: "서버 내부 오류 발생" });
    }
};