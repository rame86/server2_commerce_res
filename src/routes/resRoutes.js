// src/routes/resRoutes.js

const express = require('express');
const router = express.Router();
const resController = require('../controllers/resController');
const eventController = require('../controllers/eventController');
const testController = require('../controllers/testController');

// [GET] 이벤트 전체 목록 조회
router.get('/events', eventController.getAllEvents); // 👈 eventController로 변경

// [GET] 아티스트용: 본인이 신청한 공연 목록 조회 (Private/Management)
// 예: /msa/res/events/my?artistId=1
router.get('/events/my', eventController.getMyEvents);

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

// [GET] test
router.get('/test', testController.handleTestRequest);

// [POST] 사용자 직접 환불 요청
router.post('/refund', resController.requestRefund);

// [GET]📍 공연 정보/지도 관련
router.get('/events/:eventId/location', eventController.getEventLocation);

// [GET] 특정 유저의 전체 예약 내역 조회 
// 경로: /msa/res/member/:memberId
router.get('/member/:memberId', resController.getMyReservations);

// [GET] 특정 이벤트의 예매자 명단 조회 (아티스트 엑셀 다운로드용)
router.get('/events/:eventId/reservations', resController.getEventReservations);

// [GET] 아티스트 계정에서 조회되는 본인 이벤트 최근 5일 예매조회
router.get('/artistreserve/:memberId', resController.getRecentTicketStats);

// [GET] 특정 유저의 예약 상태 확인 (프론트엔드 폴링 주소와 일치시킴)
// 🌟 /reserve/status/:userId 를 아래와 같이 변경
router.get('/reservations/status/:ticketCode', resController.getReservationStatus);

// [POST] 유저대시보드 
router.post('/dashboard/dashboard-queue', eventController.sendDashboardQueues);

/**
 * [POST] 모든 이벤트 재고 Redis 동기화 (관리자용 Warm-up)
 * 💡 수정: 라우터에서 Service를 직접 require하지 말고 Controller에 함수를 하나 만들어서 연결해.
 */
router.post('/admin/warmup', eventController.warmupRedis); // 👈 eventController로 변경



module.exports = router;