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
        this.broadcastGameState();
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
                cards: info.cards // 항상 카드 정보 전송
            }))
        };

        for (let [playerId, playerInfo] of this.players) {
            if (playerInfo.ws.readyState === WebSocket.OPEN) {
                playerInfo.ws.send(JSON.stringify({
                    ...gameState,
                    isHost: playerId === this.hostId
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

                ws.send(JSON.stringify({
                    type: 'joinResponse',
                    roomCode: data.roomCode,
                    playerId: data.playerId,
                    isHost: data.playerId === game.hostId
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
                    game.players.delete(data.playerId);
                    
                    if (data.playerId === game.hostId && game.players.size > 0) {
                        game.hostId = Array.from(game.players.keys())[0];
                    }
                    
                    if (game.players.size === 0) {
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
                    game.players.delete(playerId);
                    if (playerId === game.hostId && game.players.size > 0) {
                        game.hostId = Array.from(game.players.keys())[0];
                    }
                    if (game.players.size === 0) {
                        rooms.delete(roomCode);
                    } else {
                        game.broadcastGameState();
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
