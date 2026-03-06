// src/controllers/eventController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const eventService = require('../services/eventService');
const resService = require('../services/resService'); // warmup 등을 위해 필요
const resRepository = require('../repositories/resRepository'); // 이벤트 목록 조회용
const redis = require('../config/redisClient'); // 🚀 Redis 클라이언트 필수!

/**
 * [1] 모든 이벤트(공연) 목록 조회
 */
exports.getAllEvents = async (req, res) => {
    try {
        // [Repository 패턴 활용] DB 계층에 직접 쿼리를 날리지 않고, 미리 정의된 리포지토리를 호출해 공연 목록을 가져옴
        const events = await resRepository.findAllEvents(); 
        
        // [방어 코드] 만약 DB 결과가 아예 없거나 null이라면, 프론트엔드에서 map 함수 등을 쓸 때 에러가 나지 않게 빈 배열로 초기화함
        if (!events) return res.status(200).json([]);

        /**
         * [BigInt 직렬화 처리] 
         * JSON.stringify는 JavaScript의 BigInt 타입을 처리하지 못하므로, 모든 속성을 순회하며 BigInt만 찾아 String으로 변환함.
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

        /**
         * [단일 레코드 조회] 
         * URL 파라미터는 문자열이므로 parseInt를 통해 10진수 숫자로 변환함. 
         * Prisma의 findUnique는 PK(Primary Key)를 사용하여 가장 빠른 속도로 하나의 데이터를 조회함.
         */
        const event = await prisma.events.findUnique({
            where: { event_id: parseInt(eventId, 10) } 
        });
        
        // [예외 처리] 만약 해당 ID로 조회된 공연이 없다면, 리소스가 없음을 알리는 404 상태코드를 반환함
        if (!event) return res.status(404).json({ message: "공연을 찾을 수 없습니다." });

        // [응답] 조회된 단일 공연 정보를 JSON 형태로 전송함
        res.json(event);
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
 * [4] 🌟 새로운 공연 등록 (Redis 실시간 동기화 포함)
 */

exports.createEvent = async (req, res) => {
    // [구조 분해 할당] 클라이언트가 전송한 바디(body) 데이터에서 필요한 필드들을 꺼내옴
    const { title, total_seats, price, description, venue, address } = req.body;

    try {
        /**
         * [트랜잭션 시작] 
         * 공연(events) 생성과 장소(event_locations) 생성은 반드시 둘 다 성공해야 하므로 prisma.$transaction을 사용함
         */
        const newEvent = await prisma.$transaction(async (tx) => {
            
            // [공연 데이터 생성] 입력을 숫자로 강제 변환하여 events 테이블에 레코드를 삽입함
            const event = await tx.events.create({
                data: {
                    title,
                    total_seats: parseInt(total_seats, 10),
                    available_seats: parseInt(total_seats, 10), // 선착순 티켓팅을 위해 초기 잔여석을 전체 좌석수로 세팅함
                    price: parseInt(price, 10),
                    description
                }
            });

            // [위치 데이터 생성] 생성된 공연의 ID를 FK(Foreign Key)로 사용하여 위치 테이블에 상세 정보를 삽입함
            await tx.event_locations.create({
                data: {
                    event_id: event.event_id,
                    venue,
                    address
                }
            });

            // [결과 반환] 트랜잭션 내부에서 생성된 최종 공연 객체를 상위 변수로 전달함
            return event;
        });

        /**
         * [Redis 캐시 동기화]
         * DB 등록이 완벽히 끝난 직후, 실시간 재고 차감의 성능을 위해 Redis에 해당 공연의 키를 생성하고 초기 잔여석을 세팅함
         */
        const stockKey = `event:stock:${newEvent.event_id}`;
        
        // [Side-Write 전략] Redis 클라이언트를 통해 메모리에 'event:stock:{id}' 형식의 키를 생성하고 값을 저장함
        await redis.set(stockKey, newEvent.available_seats);

        console.log(`✅ [신규 공연] DB 등록 및 Redis 재고 생성 완료: ${stockKey}`);

        // [성공 응답] 생성된 리소스의 정보를 담아 201(Created) 상태코드를 전송함
        res.status(201).json({
            message: "공연 등록 성공!",
            event_id: newEvent.event_id
        });

    } catch (error) {
        console.error("❌ 공연 등록 중 오류:", error.message);
        res.status(500).json({ message: "공연 등록에 실패했어." });
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
         */
        await resService.warmupAllEventsToRedis();
        
        // [관리자 확인 응답] 작업 완료 메시지를 200 상태코드와 함께 반환함
        res.status(200).json({ message: "모든 이벤트 재고가 Redis에 성공적으로 로드되었습니다." });
    } catch (err) {
        console.error("❌ Admin Warmup Error:", err);
        res.status(500).json({ error: err.message });
    }
};