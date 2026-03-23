// src/controllers/resController.js

const prisma = require('../config/prisma');
const resService = require('../services/resService');
const redis = require('../config/redisClient'); 
const { publishToQueue, ROUTING_KEYS } = require('../config/rabbitMQ');

// [1] 예매 생성 (🚀 예약 도메인의 핵심 로직)
exports.createReservation = async (req, res) => {
    // [1] 데이터 바인딩: 필요한 정보만 바디에서 추출
    const { event_id, ticket_count, selected_seats } = req.body;

    /**
     * 🌟 게이트웨이(OpenResty) 보안 연동
     * 게이트웨이가 JWT를 검증한 후 'x-user-id' 헤더에 memberId를 넣어주므로
     * 프론트에서 보내는 member_id나 Authorization 헤더를 직접 파싱할 필요가 없음!
     */
    const member_id = req.headers['x-user-id'];
    
    // [보안 검사] 게이트웨이를 거치지 않은 비정상 요청 차단
    if (!member_id) {
        return res.status(401).json({ message: "인증 정보가 없습니다. 다시 로그인해주세요." });
    }

    // [타입 보정] 정수 연산을 위해 숫자로 변환
    const count = parseInt(ticket_count, 10);

    try {
        /**
         * [비즈니스 로직 1단계: 선검증 및 재고 확보]
         * Redis 재고 차감 및 유저 잔액 검증
         */
        const bookingDetail = await resService.validateAndPrepare(event_id, count, member_id);
        
        /**
         * [비즈니스 로직 2단계: 예약 가저장 (PENDING)]
         * DB에 대기 상태로 기록
         */
        await resService.makeReservation({
            event_id,
            ticket_count: count,
            total_price: bookingDetail.totalPrice,
            booking_fee: bookingDetail.bookingFee,
            ticket_code: bookingDetail.ticketCode,
            selected_seats 
        }, member_id);

        /**
         * [비즈니스 로직 3단계: 분산 트랜잭션 (MQ 발송)]
         * 결제 서버로 작업 위임
         */
        const messagePayload = {
            orderId: bookingDetail.ticketCode,
            memberId: Number(member_id), // 헤더값은 문자열이므로 숫자로 변환
            amount: Number(bookingDetail.totalPrice),
            artistId: bookingDetail.artistId ? Number(bookingDetail.artistId) : null,
            originalPrice: Number(bookingDetail.ticketPrice), 
            fee: Number(bookingDetail.salesCommissionRate),
            quantity: Number(bookingDetail.quantity),
            type: "PAYMENT",
            eventTitle: bookingDetail.eventTitle,
            replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE
        };
        
        await publishToQueue(ROUTING_KEYS.PAY_REQUEST, messagePayload);
        console.log(`🚀 [MQ 전송] 결제 요청 발송 완료: ${bookingDetail.ticketCode}`);

        // 최종 응답 (202 Accepted)
        res.status(202).json({ 
            message: "예약 요청이 성공적으로 접수되었습니다.",
            ticket_id: bookingDetail.ticketCode,
            total_price: bookingDetail.totalPrice
        });

    } catch (error) {
        console.error("❌ 예약 처리 중 오류:", error);
        res.status(error.status || 500).json({ message: error.message || "서버 오류" });
    }
};

// [2] 특정 유저의 예약 상태 확인
exports.getReservationStatus = async (req, res) => {
    try {
        // [파라미터 추출] 조회하고자 하는 유저의 ID를 URL 경로에서 가져옴
        // const { userId } = req.params;
        // [파라미터 추출] 특정 결제 건을 확인하기 위해 티켓 코드를 받음
        const { ticketCode } = req.params;

        // [DB 조회] 해당 티켓의 현재 상태(PENDING, CONFIRMED, FAILED 등)를 가져옴
        // (주의: resService.checkStatus 함수는 서비스 단에 구현되어 있어야 해)
        const status = await resService.checkStatus(ticketCode);
        
        // [구현 예정] 비동기 처리 특성상 클라이언트가 본인의 예약이 성공했는지 폴링(Polling)할 때 사용될 엔드포인트임
        res.status(200).json({ ticketCode, status });
    } catch (error) {
        console.error("❌ 예약 상태 조회 오류:", error);
        res.status(500).json({ message: "상태 조회 중 오류 발생" });
    }
};

// [3] 환불 요청 접수 (수정: 관리자 승인 절차 추가)
exports.requestRefund = async (req, res) => {
    // [요청 데이터 수집] 티켓 코드와 회원 ID, 그리고 환불 사유(추가)를 받음
    const { ticket_code, member_id, refund_reason } = req.body; 

    try {
        const refundRequestData = await resService.prepareRefundAdminRequest(ticket_code, member_id, refund_reason);

        /**
         * 🌟 Java AdminRefundRequestDTO 규격에 100% 맞춤
         */
        const adminMessagePayload = {
            // 1. 공통 필수 정보
            category: "RES",                            // 예약 서비스 구분값
            type: "REFUND",                             // 고정값
            targetId: refundRequestData.ticketCode,     // 티켓 코드 (targetId)
            title: `[티켓] ${refundRequestData.eventTitle} 환불 요청`, // 화면 노출용 제목
            memberId: Number(member_id),
            totalPrice: Number(refundRequestData.totalPrice),
            status: "PENDING",

            // 2. 상세 데이터 (contentJson에 맵 형태로 담기)
            contentJson: {
                refundId: refundRequestData.refund_id,
                reason: refund_reason || "단순 변심",
                artistId: refundRequestData.artistId,
                quantity: refundRequestData.quantity
            },

            // 3. 부가 정보
            createdAt: new Date().toISOString()
        };

        // [MQ 발행] 관리자 환불 요청 큐로 전송
        await publishToQueue(ROUTING_KEYS.REFUND_REQ_ADMIN, adminMessagePayload);
        
        console.log(`📩 [Admin MQ] DTO 규격으로 환불 요청 전송: ${adminMessagePayload.targetId}`);

        res.status(202).json({ 
            message: "환불 요청이 관리자에게 전달되었습니다.",
            refund_id: refundRequestData.refund_id
        });

    } catch (error) {
        console.error("❌ 환불 요청 접수 실패:", error);
        res.status(error.status || 500).json({ message: error.message });
    }
};

// [4] 내 예매 내역 조회
exports.getMyReservations = async (req, res) => {
    try {
        // 🌟 수정: URL 파라미터(:memberId) 대신 게이트웨이 헤더 사용
        // 이렇게 하면 주소창에 남의 ID를 쳐도 자기 것만 나옴!
        const memberId = req.headers['x-user-id'];

        // memberId가 아예 안 들어왔을 경우만 체크
        if (!memberId) {
            return res.status(400).json({ message: "조회할 회원 ID가 없습니다." });
        }

        const list = await resService.getMyReservations(memberId);

        res.status(200).json({
            message: "성공적으로 조회되었습니다.",
            count: list.length,
            data: list
        });
    } catch (error) {
        console.error("❌ 내 예매 조회 오류:", error);
        res.status(500).json({ message: "내역을 불러오는 중 오류가 발생했습니다." });
    }
};

// [GET] 이벤트 예매자 명단 조회
exports.getEventReservations = async (req, res) => {
    try {
        const {eventId} = req.params;
        const attendes = await resService.getAttendesByEventId(eventId);

        res.status(200).json(attendes);
    } catch (error) {
        console.log("예매자 명단 조회 에러", error);
        res.status(500).json({message:"명단 조회에 실패했습니다."})
    }
}

// [아티스트 대시보드] 최근 5일 예매건수 조회(빈 날짜는 0)
exports.getRecentTicketStats = async (req, res) => {
    try {
        const {memberId} =req.params;

        if(!memberId || isNaN(memberId)) {
            return res.status(400).json({ success: false, message: '유효한 아티스트 ID가 아닙니다.'});
        }
        
        const data = await resService.getTicketStats(memberId);
        return res.status(200).json({
            success: true,
            data
        });
    } catch (error) {
        console.error('[getRecentTicketStats] Error:', error);
        return res.status(500).json({success: false, message: '통계 조회 실패'});
    }
};

// [어드민 환불내역 조회]
exports.refundList = async (req, res) => {
    try {
        const data = await resService.getPendingRefunds();
        res.status(200).json({
            success: true,
            data: data 
        });
    } catch (error) {
        console.error("Refund List Error:", error);
        res.status(500).json({ success: false, message: "내역 조회 실패" });
    }
};

// [어드민 환불 완료 내역 조회]
exports.refundCompletedList = async (req, res) => {
    try {
        const data = await resService.getCompletedRefunds();
        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error("Refund Completed List Error:", error);
        res.status(500).json({ success: false, message: "완료 내역 조회 실패" });
    }
};