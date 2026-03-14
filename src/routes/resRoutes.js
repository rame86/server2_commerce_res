// src/routes/resRoutes.js

const express = require('express');
const router = express.Router();
const resController = require('../controllers/resController');
const eventController = require('../controllers/eventController');
const testController = require('../controllers/testController');

// [GET] 이벤트 전체 목록 조회
router.get('/events', eventController.getAllEvents); // 👈 eventController로 변경

// [POST] 🌟 새로운 공연 등록 (Redis 동기화 로직 포함된 버전)
// 예: http://localhost:8082/events
router.post('/events', eventController.requestEventApproval);

// [GET] 특정 이벤트 상세 정보 조회 (Booking Process 진입 시 필요할 수 있음)
// 예: http://localhost:8082/events/:eventId
router.get('/events/:eventId', eventController.getEventDetail); // 👈 eventController로 변경

// [POST] 예약 생성 및 처리 (UserBookingProcess에서 최종 클릭 시 호출)
router.post('/reserve', resController.createReservation);

// [GET] 특정 유저의 예약 상태 확인 (선택 사항)
router.get('/reserve/status/:userId', resController.getReservationStatus);

// [GET] 특정 유저의 예약 상태 확인 (선택 사항)
router.get('/test', testController.handleTestRequest);

// [POST] 사용자 직접 환불 요청
router.post('/refund', resController.requestRefund);

// [GET]📍 공연 정보/지도 관련
router.get('/events/:eventId/location', eventController.getEventLocation);

// [GET] 특정 유저의 전체 예약 내역 조회 
// 경로: /msa/res/member/:memberId

router.get('/member/:memberId', resController.getMyReservations);

/**
 * [POST] 모든 이벤트 재고 Redis 동기화 (관리자용 Warm-up)
 * 💡 수정: 라우터에서 Service를 직접 require하지 말고 Controller에 함수를 하나 만들어서 연결해.
 */
router.post('/admin/warmup', eventController.warmupRedis); // 👈 eventController로 변경



module.exports = router;