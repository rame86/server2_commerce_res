// src/controllers/eventController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const eventService = require('../services/eventService');
const resService = require('../services/resService'); // warmup 등을 위해 필요
const resRepository = require('../repositories/resRepository'); // 이벤트 목록 조회용
const redis = require('../config/redisClient'); // 🚀 Redis 클라이언트 필수!

// [1] 모든 이벤트(공연) 목록 조회 (resController에서 이동)
exports.getAllEvents = async (req, res) => {
    try {
        const events = await resRepository.findAllEvents(); 
        if (!events) return res.status(200).json([]);

        // [핵심] BigInt 변환 (JSON 파싱 에러 방지)
        const safeEvents = JSON.parse(JSON.stringify(events, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ));

        res.status(200).json(safeEvents);
    } catch (err) {
        console.error("❌ 이벤트 조회 오류:", err); 
        res.status(500).json({ message: "공연 목록을 불러오지 못했습니다." });
    }
};

// [2] 특정 이벤트 상세 정보 조회 (resController에서 이동)
exports.getEventDetail = async (req, res) => {
    try {
        const { eventId } = req.params;
        const event = await prisma.events.findUnique({
            where: { event_id: parseInt(eventId, 10) } // DB 스키마에 따라 events 테이블명 확인!
        });
        
        if (!event) return res.status(404).json({ message: "공연을 찾을 수 없습니다." });
        res.json(event);
    } catch (error) {
        console.error("❌ 상세 조회 오류:", error);
        res.status(500).json({ message: "상세 조회 중 오류 발생" });
    }
};

// [3] 공연의 지도 정보(장소, 주소) 조회
exports.getEventLocation = async (req, res) => {
    const { eventId } = req.params;
    try {
        const event = await prisma.events.findUnique({
            where: { event_id: parseInt(eventId, 10) },
            include: { event_locations: true }
        });

        if (!event || !event.event_locations) {
            return res.status(404).json({ message: "해당 공연 정보를 찾을 수 없어." });
        }

        let loc = event.event_locations;

        if (!loc.latitude || !loc.longitude) {
            const coords = await eventService.getCoordinates(loc.address);
            if (coords) {
                loc = await prisma.event_locations.update({
                    where: { event_id: loc.event_id },
                    data: { latitude: coords.lat, longitude: coords.lng }
                });
            }
        }

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

// [4] 🌟 새로운 공연 등록 (Redis 실시간 동기화 포함)
exports.createEvent = async (req, res) => {
    const { title, total_seats, price, description, venue, address } = req.body;

    try {
        // [핵심] DB 트랜잭션: 이벤트와 위치 정보를 동시에 저장
        const newEvent = await prisma.$transaction(async (tx) => {
            const event = await tx.events.create({
                data: {
                    title,
                    total_seats: parseInt(total_seats, 10),
                    available_seats: parseInt(total_seats, 10),
                    price: parseInt(price, 10),
                    description
                }
            });

            await tx.event_locations.create({
                data: {
                    event_id: event.event_id,
                    venue,
                    address
                }
            });

            return event;
        });

        // 🚀 Redis 실시간 재고 생성
        const stockKey = `event:stock:${newEvent.event_id}`;
        await redis.set(stockKey, newEvent.available_seats);

        console.log(`✅ [신규 공연] DB 등록 및 Redis 재고 생성 완료: ${stockKey}`);

        res.status(201).json({
            message: "공연 등록 성공!",
            event_id: newEvent.event_id
        });

    } catch (error) {
        console.error("❌ 공연 등록 중 오류:", error.message);
        res.status(500).json({ message: "공연 등록에 실패했어." });
    }
};

// [5] 모든 이벤트 재고 Redis 동기화 (관리자용 Warm-up - 공연 관리 기능이므로 여기로 이동)
exports.warmupRedis = async (req, res) => {
    try {
        await resService.warmupAllEventsToRedis();
        res.status(200).json({ message: "모든 이벤트 재고가 Redis에 성공적으로 로드되었습니다." });
    } catch (err) {
        console.error("❌ Admin Warmup Error:", err);
        res.status(500).json({ error: err.message });
    }
};