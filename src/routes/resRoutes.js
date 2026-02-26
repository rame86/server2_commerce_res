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

module.exports = router;