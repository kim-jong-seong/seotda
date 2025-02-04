const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

class CardGame {
    constructor(roomCode) {
        this.roomCode = roomCode;
        this.MAX_PLAYERS = 10;
        this.CARDS_PER_PLAYER = 2;
        this.cards = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
        this.players = new Map();
        this.gameStarted = false;
        this.hostId = null;
        this.firstGamePlayers = new Set(); // 각 플레이어의 첫 게임 여부를 추적
        this.diedPlayers = new Set(); // 다이한 플레이어 목록
        this.disconnectedPlayers = new Map(); // 연결이 끊긴 플레이어의 정보 저장
        this.reconnectTimeout = 300000; // 5분 타임아웃
    }

    leaveRoom(playerId) {
        const playerInfo = this.players.get(playerId);
        if (playerInfo) {
            // 게임 중이거나 카드를 가지고 있는 경우에만 저장
            if (this.gameStarted || playerInfo.cards?.length > 0) {
                this.disconnectedPlayers.set(playerId, {
                    ...playerInfo,
                    disconnectedAt: Date.now(),
                    cards: playerInfo.cards
                });
            }
            this.players.delete(playerId);
            
            if (playerId === this.hostId && this.players.size > 0) {
                this.hostId = Array.from(this.players.keys())[0];
            }
            return true;
        }
        return false;
    }

    handleDisconnect(playerId) {
        const playerInfo = this.players.get(playerId);
        if (playerInfo) {
            this.disconnectedPlayers.set(playerId, {
                ...playerInfo,
                disconnectedAt: Date.now(),
                cards: playerInfo.cards
            });
            this.players.delete(playerId);
            
            // 타임아웃 설정
            setTimeout(() => {
                if (this.disconnectedPlayers.has(playerId)) {
                    this.disconnectedPlayers.delete(playerId);
                    this.broadcastGameState();
                }
            }, this.reconnectTimeout);
            
            this.broadcastGameState();
        }
    }

    handleReconnect(playerId, ws, playerName) {
        const disconnectedInfo = this.disconnectedPlayers.get(playerId);
        if (disconnectedInfo) {
            const cards = this.diedPlayers.has(playerId) ? null : disconnectedInfo.cards;
            
            this.players.set(playerId, {
                ws,
                name: playerName,
                cards: cards
            });
            this.disconnectedPlayers.delete(playerId);
            
            if (this.gameStarted && cards) {
                ws.send(JSON.stringify({
                    type: 'cards',
                    cards: cards
                }));
            }
            return true;
        }
        return false;
    }

    playerDie(playerId) {
        if (!this.players.has(playerId)) {
            return { error: "플레이어를 찾을 수 없습니다." };
        }
        
        this.diedPlayers.add(playerId);
        const playerInfo = this.players.get(playerId);
        playerInfo.cards = null; // 다이한 플레이어의 카드 정보 제거
        
        this.broadcastGameState();
        return { success: true };
    }

    startGame(hostId) {
        if (hostId !== this.hostId) {
            return { error: "방장만 게임을 시작할 수 있습니다." };
        }

        if (this.players.size < 2) {
            return { error: "게임을 시작하기 위해서는 최소 2명의 플레이어가 필요합니다." };
        }

        if (this.gameStarted) {
            return { error: "게임이 이미 시작되었습니다." };
        }

        this.gameStarted = true;
        this.distributeCards();
        return { success: true, message: "게임이 시작되었습니다." };
    }

    distributeCards() {
        const shuffledCards = [...this.cards].sort(() => Math.random() - 0.5);
        let cardIndex = 0;

        for (let [playerId, playerInfo] of this.players) {
            playerInfo.cards = shuffledCards.slice(cardIndex, cardIndex + this.CARDS_PER_PLAYER);
            cardIndex += this.CARDS_PER_PLAYER;

            if (playerInfo.ws.readyState === WebSocket.OPEN) {
                playerInfo.ws.send(JSON.stringify({
                    type: 'cards',
                    cards: playerInfo.cards
                }));
            }
        }

        this.broadcastGameState();
    }

    endGame(hostId) {
        if (hostId !== this.hostId) {
            return { error: "방장만 게임을 종료할 수 있습니다." };
        }
        
        this.gameStarted = false;
        
        // 게임에 참여한 모든 플레이어를 firstGamePlayers에서 제거
        for (let playerId of this.players.keys()) {
            this.firstGamePlayers.add(playerId);
        }

        // 다이한 플레이어들의 카드는 null로 설정
        for (let playerId of this.diedPlayers) {
            if (this.players.has(playerId)) {
                this.players.get(playerId).cards = null;
            }
        }
        
        this.broadcastGameState();
        this.diedPlayers.clear(); // 다이 목록 초기화
        return { success: true };
    }

    broadcastGameState() {
        const gameState = {
            type: 'gameState',
            roomCode: this.roomCode,
            totalPlayers: this.players.size,
            gameStarted: this.gameStarted,
            players: Array.from(this.players.entries()).map(([id, info]) => ({
                id,
                name: info.name,
                hasCards: info.cards?.length > 0,
                isHost: id === this.hostId,
                isFirstGame: !this.firstGamePlayers.has(id),
                isDied: this.diedPlayers.has(id), // 다이 여부 추가
                cards: info.cards
            }))
        };

        for (let [playerId, playerInfo] of this.players) {
            if (playerInfo.ws.readyState === WebSocket.OPEN) {
                playerInfo.ws.send(JSON.stringify({
                    ...gameState,
                    isHost: playerId === this.hostId,
                    isFirstGame: !this.firstGamePlayers.has(playerId),
                    isDied: this.diedPlayers.has(playerId)
                }));
            }
        }
    }
}

function generateRoomCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms.has(code));
    return code;
}

wss.on('connection', (ws) => {
    console.log('새로운 클라이언트가 연결되었습니다.');

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        console.log('Received:', data);
        
        switch (data.type) {
            case 'die': {
                const game = rooms.get(data.roomCode);
                if (game) {
                    const result = game.playerDie(data.playerId);
                    if (result.error) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: result.error
                        }));
                    }
                }
                break;
            }

            case 'createRoom': {
                const roomCode = generateRoomCode();
                const game = new CardGame(roomCode);
                rooms.set(roomCode, game);
                game.hostId = data.playerId;
                game.players.set(data.playerId, { 
                    ws: ws,
                    name: data.playerName,
                    cards: []
                });
                
                ws.send(JSON.stringify({
                    type: 'roomCreated',
                    roomCode: roomCode,
                    playerId: data.playerId,
                    isHost: true
                }));
                game.broadcastGameState();
                break;
            }

            case 'joinRoom': {
                const game = rooms.get(data.roomCode);
                if (!game) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: '존재하지 않는 방 코드입니다.'
                    }));
                    return;
                }
            
                // 동일한 닉네임 체크
                for (let [_, playerInfo] of game.players) {
                    if (playerInfo.name === data.playerName && !game.disconnectedPlayers.has(data.playerId)) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: '이미 사용 중인 닉네임입니다.'
                        }));
                        return;
                    }
                }
            
                // 재접속 시도
                const rejoined = game.handleReconnect(data.playerId, ws, data.playerName);
                if (!rejoined) {
                    if (game.gameStarted) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: '이미 게임이 시작되었습니다.'
                        }));
                        return;
                    }
            
                    if (game.players.size >= game.MAX_PLAYERS) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: '방이 가득 찼습니다.'
                        }));
                        return;
                    }
            
                    game.players.set(data.playerId, {
                        ws: ws,
                        name: data.playerName,
                        cards: []
                    });
                }
            
                ws.send(JSON.stringify({
                    type: 'joinResponse',
                    roomCode: data.roomCode,
                    playerId: data.playerId,
                    isHost: data.playerId === game.hostId,
                    rejoined: rejoined
                }));
                
                game.broadcastGameState();
                break;
            }

            case 'start': {
                const game = rooms.get(data.roomCode);
                if (game) {
                    const result = game.startGame(data.playerId);
                    if (result.error) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: result.error
                        }));
                    }
                }
                break;
            }

            case 'end': {
                const game = rooms.get(data.roomCode);
                if (game) {
                    const result = game.endGame(data.playerId);
                    if (result.error) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: result.error
                        }));
                    }
                }
                break;
            }

            case 'leaveRoom': {
                const game = rooms.get(data.roomCode);
                if (game) {
                    game.leaveRoom(data.playerId);
                    if (game.players.size === 0 && game.disconnectedPlayers.size === 0) {
                        rooms.delete(data.roomCode);
                    } else {
                        game.broadcastGameState();
                    }
                }
                ws.send(JSON.stringify({
                    type: 'leftRoom'
                }));
                break;
            }
        }
    });

    ws.on('close', () => {
        for (let [roomCode, game] of rooms) {
            for (let [playerId, playerInfo] of game.players) {
                if (playerInfo.ws === ws) {
                    game.handleDisconnect(playerId);
                    if (playerId === game.hostId && game.players.size > 0) {
                        game.hostId = Array.from(game.players.keys())[0];
                    }
                    if (game.players.size === 0 && game.disconnectedPlayers.size === 0) {
                        rooms.delete(roomCode);
                    }
                    break;
                }
            }
        }
    });
});

server.listen(5000, () => {
    console.log('서버가 5000번 포트에서 시작되었습니다.');
});
