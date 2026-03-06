// src/controller/resController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const resService = require('../services/resService');
const resRepository = require('../repositories/resRepository'); 
const redis = require('../config/redisClient'); 
const { publishToQueue, ROUTING_KEYS } = require('../config/rabbitMQ');

// 1. 모든 이벤트(공연) 목록 조회 (기존과 동일)
exports.getAllEvents = async (req, res) => {
    try {
        const events = await resRepository.findAllEvents(); 
        if (!events) return res.status(200).json([]);

        // [핵심] BigInt 변환
        const safeEvents = JSON.parse(JSON.stringify(events, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ));

        res.status(200).json(safeEvents);
    } catch (err) {
        console.error("이벤트 조회 컨트롤러 오류:", err); 
        res.status(500).json({ message: "공연 목록을 불러오지 못했습니다." });
    }
};

// 2. 예매 생성 (🚀 확 얇아진 핵심 로직)
exports.createReservation = async (req, res) => {
    const { event_id, ticket_count, member_id } = req.body;
    const count = parseInt(ticket_count, 10);
    const clientToken = req.headers.authorization?.split(' ')[1];

    if (!clientToken) return res.status(401).json({ message: "토큰이 없습니다." });

    try {
        // [1] 토큰 검증 (Redis)
        const redisData = await redis.hGetAll(`AUTH:MEMBER:${member_id}`);
        if (!redisData || Object.keys(redisData).length === 0 || redisData.token !== clientToken) {
            return res.status(401).json({ message: "유효하지 않은 토큰입니다." });
        }

        // [2] 서비스 계층 호출 (재고 차감, 포인트 검증)
        const bookingDetail = await resService.validateAndPrepare(event_id, count, member_id);
        
        // [3] DB에 PENDING 상태 저장
        await resService.makeReservation({
            event_id,
            ticket_count: count,
            total_price: bookingDetail.totalPrice,
            ticket_code: bookingDetail.ticketCode
        }, member_id);

        // [4] RabbitMQ로 메세지 던지기
        const messagePayload = {
            orderId: bookingDetail.ticketCode,
            memberId: Number(member_id),
            amount: Number(bookingDetail.totalPrice),
            type: "PAYMENT",
            eventTitle: bookingDetail.eventTitle,
            replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE // 💡 "res.status.update"
        };
        
        // 🚨 꿀팁: 큐 이름('pay.request.queue')이 아니라 라우팅 키('pay.request')를 써야 해!
        // config/rabbitMQ.js의 ROUTING_KEYS.PAY_REQUEST를 사용하자.
        await publishToQueue(ROUTING_KEYS.PAY_REQUEST, messagePayload);
        
        console.log(`🚀 [MQ 전송] 결제 서버로 발송 완료: ${bookingDetail.ticketCode}`);

        // [5] 성공 응답
        res.status(202).json({ 
            message: "예약 요청이 성공적으로 접수되었습니다.",
            ticket_id: bookingDetail.ticketCode,
            total_price: bookingDetail.totalPrice
        });

    } catch (error) {
        console.error("예약 처리 중 오류:", error);
        res.status(error.status || 500).json({ message: error.message || "서버 오류" });
    }
};

// 3. 특정 이벤트 상세 정보 조회 (기존과 동일)
exports.getEventDetail = async (req, res) => {
    try {
        const { eventId } = req.params;
        const event = await prisma.event.findUnique({
            where: { event_id: parseInt(eventId) }
        });
        
        if (!event) return res.status(404).json({ message: "공연을 찾을 수 없습니다." });
        res.json(event);
    } catch (error) {
        res.status(500).json({ message: "상세 조회 중 오류 발생" });
    }
};

// 4. 특정 유저의 예약 상태 확인 (기존과 동일)
exports.getReservationStatus = async (req, res) => {
    try {
        const { userId } = req.params;
        res.json({ message: "조회 기능 준비 중", userId });
    } catch (error) {
        res.status(500).json({ message: "상태 조회 중 오류 발생" });
    }
};

// 5. 환불 요청 접수 (🚀 서비스로 위임하여 깔끔해짐)
exports.requestRefund = async (req, res) => {
    const { ticket_code, member_id } = req.body; 

    try {
        const refundPayload = await resService.processRefund(ticket_code, member_id);

        // 환불 데이터 규격 맞추기
        const messagePayload = {
            orderId: refundPayload.ticket_code,
            memberId: Number(refundPayload.member_id),
            amount: Number(refundPayload.cancel_amount),
            type: "REFUND",
            replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE
        };

        // 💡 환불도 결제 요청 키('pay.request')를 사용해 (Spring 명세서 기준)
        await publishToQueue(ROUTING_KEYS.PAY_REQUEST, messagePayload);

        res.status(200).json({ message: "환불 요청이 접수되었습니다." });
    } catch (error) {
        console.error("환불 오류:", error);
        res.status(error.status || 500).json({ message: error.message });
    }
};


exports.warmupRedis = async (req, res) => {
    try {
        await resService.warmupAllEventsToRedis();
        res.status(200).json({ message: "모든 이벤트 재고가 Redis에 성공적으로 로드되었습니다." });
    } catch (err) {
        console.error("Admin Warmup Error:", err);
        res.status(500).json({ error: err.message });
    }
};