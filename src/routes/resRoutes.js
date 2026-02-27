//resRoutes.js

const express = require('express');
const router = express.Router();
const resController = require('../controllers/resController');
const testController = require('../controllers/testController');

// [GET] 이벤트 전체 목록 조회
router.get('/events', resController.getAllEvents);

// [GET] 특정 이벤트 상세 정보 조회 (Booking Process 진입 시 필요할 수 있음)
// 예: http://localhost:8082/events/:eventId
router.get('/events/:eventId', resController.getEventDetail);

// [POST] 예약 생성 및 처리 (UserBookingProcess에서 최종 클릭 시 호출)
router.post('/reserve', resController.createReservation);

// [GET] 특정 유저의 예약 상태 확인 (선택 사항)
router.get('/reserve/status/:userId', resController.getReservationStatus);

// [GET] 특정 유저의 예약 상태 확인 (선택 사항)
router.get('/test', testController.handleTestRequest);


// [POST] 모든 이벤트 재고 Redis 동기화 (관리자용 Warm-up)
// 서버 재시작 없이 DB -> Redis 강제 동기화가 필요할 때 호출
router.post('/admin/warmup', async (req, res) => {
    try {
        const resService = require('../services/resService');
        await resService.warmupAllEventsToRedis();
        res.status(200).json({ message: "모든 이벤트 재고가 Redis에 성공적으로 로드되었습니다." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;