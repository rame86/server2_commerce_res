// src/controllers/eventController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const eventService = require('../services/eventService');
const resService = require('../services/resService'); // warmup 등을 위해 필요
const eventRepository = require('../repositories/eventRepository'); // 이벤트 목록 조회용
const redis = require('../config/redisClient'); // 🚀 Redis 클라이언트 필수!
const mq = require('../config/rabbitMQ');

/**
 * [1] 모든 이벤트(공연) 목록 조회
 * 서비스 초기 화면에 뿌려줄 모든 공연 데이터를 가져옴
 */
exports.getAllEvents = async (req, res) => {
    try {
        // [Repository 패턴 활용] DB 계층에 직접 쿼리를 날리지 않고, 미리 정의된 리포지토리를 호출해 공연 목록을 가져옴
        const events = await eventRepository.findAllEvents();
        
        // [방어 코드] 만약 DB 결과가 아예 없거나 null이라면, 프론트엔드에서 map 함수 등을 쓸 때 에러가 나지 않게 빈 배열로 초기화함
        if (!events) return res.status(200).json([]);

        /**
         * [BigInt 직렬화 처리] 
         * JSON.stringify는 JavaScript의 BigInt 타입을 처리하지 못하므로, 모든 속성을 순회하며 BigInt만 찾아 String으로 변환함.
         * 이를 문자열로 변환해주지 않으면 서버가 뻗기 때문에 반드시 거쳐야 하는 변환 과정
         * 이 작업을 거치지 않으면 "Do not know how to serialize a BigInt" 에러가 발생하며 서버가 중단됨.
         */
        const safeEvents = JSON.parse(JSON.stringify(events, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ));

        // [최종 응답] 직렬화 처리가 완료된 안전한 JSON 데이터를 클라이언트에 200 상태코드와 함께 전송함
        res.status(200).json(safeEvents);
    } catch (err) {
        console.error("❌ 이벤트 조회 오류:", err); 
        res.status(500).json({ message: "공연 목록을 불러오지 못했습니다." });
    }
};

/**
 * [2] 특정 이벤트 상세 정보 조회
 */
exports.getEventDetail = async (req, res) => {
    try {
        // [파라미터 추출] 클라이언트가 요청한 URL 경로에서 :eventId 변수값을 꺼내옴
        const { eventId } = req.params;
        const parsedEventId = parseInt(eventId, 10);

        /**
         * [단일 레코드 조회] 
         * URL 파라미터는 문자열이므로 parseInt를 통해 10진수 숫자로 변환함. 
         * Prisma의 findUnique는 PK(Primary Key)를 사용하여 가장 빠른 속도로 하나의 데이터를 조회함.
         */
        const event = await prisma.events.findUnique({
            where: { event_id: parsedEventId },
            include: {
                event_locations: true // 👈 이 부분이 추가되어야 venue를 가져올 수 있어!
            }
        });
        
        // [예외 처리] 만약 해당 ID로 조회된 공연이 없다면, 리소스가 없음을 알리는 404 상태코드를 반환함
        if (!event) return res.status(404).json({ message: "공연을 찾을 수 없습니다." });

        // 🌟 [추가 로직] 해당 공연의 "취소/환불" 되지 않은 유효한 예약 좌석 싹 긁어오기
        const reservations = await prisma.reservations.findMany({
            where: {
                event_id: parsedEventId,
                status: {
                    notIn: ['FAILED', 'REFUNDED'] // 취소되거나 환불된 건 좌석을 다시 풀어줘야 하니까 제외!
                },
                selected_seats: {
                    not: null // 좌석 정보가 NULL이 아닌 것만 가져오기
                }
            },
            select: {
                selected_seats: true
            }
        });

        // 🌟 [배열 합치기] 각각의 예약에서 가져온 좌석 배열을 하나의 1차원 배열로 쫙 펴줌
        // 예: [ {selected_seats: ["E1", "E2"]}, {selected_seats: ["A1"]} ] 
        // -> ["E1", "E2", "A1"]
        let reservedSeatsList = [];
        reservations.forEach(res => {
            if (Array.isArray(res.selected_seats)) {
                reservedSeatsList.push(...res.selected_seats);
            }
        });
        
        // [BigInt 처리] (필요하다면 getAllEvents처럼 직렬화 로직 추가 가능)
        const safeEvent = JSON.parse(JSON.stringify(event, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ));

        // [응답] 조회된 단일 공연 정보를 JSON 형태로 전송함
        res.json(safeEvent);
    } catch (error) {
        console.error("❌ 상세 조회 오류:", error);
        res.status(500).json({ message: "상세 조회 중 오류 발생" });
    }
};

/**
 * [3] 공연의 지도 정보(장소, 주소) 조회 및 좌표 보정
 */
exports.getEventLocation = async (req, res) => {
    const { eventId } = req.params;
    try {
        /**
         * [관계형 데이터 로드]
         * findUnique 조회 시 'include'를 사용하여 공연 정보뿐만 아니라 자식 테이블인 'event_locations' 데이터까지 함께 가져옴 (Eager Loading)
         */
        const event = await prisma.events.findUnique({
            where: { event_id: parseInt(eventId, 10) },
            include: { event_locations: true }
        });

        // [유효성 검사] 공연 데이터가 없거나, 연결된 위치 데이터가 테이블에 존재하지 않는 경우를 걸러냄
        if (!event || !event.event_locations) {
            return res.status(404).json({ message: "해당 공연 정보를 찾을 수 없어." });
        }

        // [참조 할당] 가독성을 위해 위치 정보 객체를 loc 변수에 따로 담아둠
        let loc = event.event_locations;

        /**
         * [좌표 유무 확인]
         * DB에 저장된 위도(latitude)나 경도(longitude) 값이 비어있는지 체크함
         */
        if (!loc.latitude || !loc.longitude) {
            // [외부 API 호출] 좌표가 없다면 eventService의 카카오 지오코딩 로직을 실행하여 주소를 좌표 숫자로 변환함
            const coords = await eventService.getCoordinates(loc.address);
            
            // [DB 실시간 보정] 카카오 API로부터 좌표를 받아오는 데 성공했다면
            if (coords) {
                // [Self-healing] 다음 조회 시 API 호출을 하지 않도록 획득한 좌표를 DB에 즉시 기록하여 보존함
                loc = await prisma.event_locations.update({
                    where: { event_id: loc.event_id },
                    data: { latitude: coords.lat, longitude: coords.lng }
                });
            }
        }

        // [최종 데이터 가공] 클라이언트 지도 라이브러리가 즉시 사용할 수 있도록 정제된 포맷으로 반환함
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

/**
 * [날짜 포맷 변환]
 * Java Spring의 LocalDateTime 형식이 인식할 수 있도록 ISO 표준(T 포함)으로 변환
 */
const formatToSpring = (dateInput) => {
    const d = new Date(dateInput);
    const pad = (n) => n < 10 ? '0' + n : n;
    
    // 날짜와 시간 사이에 'T'를 명시적으로 넣어줌
    return d.getFullYear() + '-' +
           pad(d.getMonth() + 1) + '-' +
           pad(d.getDate()) + 'T' +  // 👈 여기가 핵심! 공백 대신 'T'
           pad(d.getHours()) + ':' +
           pad(d.getMinutes()) + ':' +
           pad(d.getSeconds());
};

/**
 * [4] 🌟 공연 등록 신청 (이미지 저장 + 신규 필드 반영)
 */
exports.requestEventApproval = async (req, res) => {
    // 1. 데이터 추출 (신규 필드 추가: age_limit, running_time, is_standing, seat_map_config)
    const { 
        requester_id, member_id, 
        title, total_capacity, price, description, venue, address, 
        event_date, open_time, close_time, 
        images, // 👈 ["url1", "url2"] 형태의 배열
        artist_id, artist_name, event_type,
        age_limit, running_time, is_standing, seat_map_config 
    } = req.body;

    try {
        const finalRequesterId = requester_id || member_id;
        const finalArtistId = artist_id || finalRequesterId;

        if (!finalRequesterId) throw new Error("requester_id(또는 member_id)가 누락되었습니다.");

        // 주소를 좌표로 변환
        const coords = await eventService.getCoordinates(address);
        const lat = coords ? coords.lat : null;
        const lng = coords ? coords.lng : null;

        // 관리자 확인용 스냅샷 (신규 필드 포함)
        const eventSnapshot = {
            title, artist_id, artist_name, event_type, description,
            price: parseInt(price, 10),
            total_capacity: parseInt(total_capacity, 10),
            venue, address, event_date, open_time, close_time,
            age_limit: parseInt(age_limit, 10) || 0,
            running_time: parseInt(running_time, 10) || 0,
            is_standing: is_standing === true || is_standing === 'true',
            seat_map_config: seat_map_config || null,
            images: images || []
        };

        /**
         * 2. [핵심 로직] 트랜잭션 처리
         * 이벤트 -> 위치 -> 이미지 -> 승인요청 순서로 저장 (원자성 보장)
         */
        const { newEvent, approvalReq } = await prisma.$transaction(async (tx) => {
            // (1) 공연 기본 정보 생성 (신규 필드 포함)
            const createdEvent = await tx.events.create({
                data: {
                    title, 
                    artist_id: BigInt(finalArtistId),
                    artist_name, 
                    event_type, 
                    description,
                    price: parseInt(price, 10),
                    total_capacity: parseInt(total_capacity, 10),
                    available_seats: parseInt(total_capacity, 10),
                    event_date: new Date(event_date),
                    open_time: new Date(open_time),
                    close_time: new Date(close_time),
                    age_limit: parseInt(age_limit, 10) || 0,
                    running_time: parseInt(running_time, 10) || 0,
                    is_standing: is_standing === true || is_standing === 'true',
                    seat_map_config: seat_map_config || null,
                    approval_status: 'PENDING'
                }
            });

            // (2) 장소 정보 생성
            await tx.event_locations.create({
                data: {
                    event_id: createdEvent.event_id,
                    venue, address, latitude: lat, longitude: lng
                }
            });

            // (3) 🌟 [신규] 사진 정보 생성 (Bulk Insert)
            if (images && Array.isArray(images) && images.length > 0) {
                await tx.event_images.createMany({
                    data: images.map((url, index) => ({
                        event_id: createdEvent.event_id,
                        image_url: url,
                        image_role: index === 0 ? 'POSTER' : 'DETAIL', // 첫 번째는 포스터, 나머지는 상세
                        sort_order: index
                    }))
                });
            }

            // (4) 승인 요청 데이터 생성
            const createdApproval = await tx.event_approvals.create({
                data: {
                    event_id: createdEvent.event_id,
                    requester_id: BigInt(finalRequesterId),
                    status: 'PENDING',
                    event_snapshot: eventSnapshot
                }
            });

            // 승인 ID 업데이트
            await tx.events.update({
                where: { event_id: createdEvent.event_id },
                data: { approval_id: createdApproval.approval_id }
            });

            return { newEvent: createdEvent, approvalReq: createdApproval };
        });

        // 3. [MSA] Java DTO 조립 (신규 필드 포함하여 관리자에게 발송)
        const eventResultDTO = {
            approvalId: Number(newEvent.event_id), 
            requesterId: Number(finalRequesterId), 
            status: 'PENDING',
            eventTitle: title,
            rejectionReason: null,
            createdAt: formatToSpring(approvalReq.created_at),
            eventStartDate: formatToSpring(event_date),
            location: venue,
            price: Number(price),
            // 추가된 디테일 정보
            ageLimit: parseInt(age_limit, 10) || 0,
            runningTime: parseInt(running_time, 10) || 0,
            isStanding: is_standing === true || is_standing === 'true'
        };

        // RabbitMQ 전송 (라우팅 키: admin.event.request)
        await mq.publishToQueue(mq.ROUTING_KEYS.EVENT_REQ_ADMIN, eventResultDTO);

        console.log(`📤 [관리자 전송] ID: ${eventResultDTO.approvalId}, 제목: ${eventResultDTO.eventTitle}`);
        
        res.status(202).json({ 
            message: "신청 완료 및 이미지 등록 성공", 
            approvalId: eventResultDTO.approvalId 
        });

    } catch (error) {
        console.error("❌ 승인 요청 실패:", error.message);
        res.status(500).json({ message: `신청 실패: ${error.message}` });
    }
};

/**
 * [5] 모든 이벤트 재고 Redis 동기화 (Admin Warm-up)
 */
exports.warmupRedis = async (req, res) => {
    try {
        /**
         * [캐시 워밍 실행]
         * 관리자가 수동으로 DB의 재고 데이터를 Redis로 밀어넣는 서비스를 호출함. 
         * 이는 서버 장애 복구 후나 대규모 이벤트 오픈 직전에 재고를 메모리에 미리 올리는 필수 작업임.
         * DB에 있는 모든 재고 정보를 Redis로 복사함 (티켓 오픈 전 필수 작업)
         */
        await resService.warmupAllEventsToRedis();
        
        // [관리자 확인 응답] 작업 완료 메시지를 200 상태코드와 함께 반환함
        res.status(200).json({ message: "모든 이벤트 재고가 Redis에 성공적으로 로드되었습니다." });
    } catch (err) {
        console.error("❌ Admin Warmup Error:", err);
        res.status(500).json({ error: err.message });
    }
};