// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const path = require('path');

// 정적 파일 제공
app.use(express.static(path.join(__dirname, 'public')));

// 기본 라우트
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

class CardGame {
    constructor() {
        this.MAX_PLAYERS = 10;
        this.CARDS_PER_PLAYER = 2;
        this.cards = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
        this.players = new Map();
        this.gameStarted = false;
        this.hostId = null;
    }

    addPlayer(ws, playerId, playerName) {
        if (this.gameStarted) {
            return { error: "게임이 이미 시작되었습니다." };
        }

        if (this.players.size >= this.MAX_PLAYERS) {
            return { error: "최대 플레이어 수에 도달했습니다." };
        }

        // 첫 번째 접속자를 방장으로 지정
        if (this.players.size === 0) {
            this.hostId = playerId;
        }

        this.players.set(playerId, {
            ws,
            name: playerName,
            cards: []
        });

        return {
            success: true,
            message: `${playerName}님이 게임에 참가하셨습니다. (현재 인원: ${this.players.size}명)`,
            isHost: playerId === this.hostId
        };
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

            // 각 플레이어에게 자신의 카드 정보 전송
            const message = JSON.stringify({
                type: 'cards',
                cards: playerInfo.cards
            });
            playerInfo.ws.send(message);
        }

        // 전체 게임 상태 업데이트를 모든 플레이어에게 브로드캐스트
        this.broadcastGameState();
    }

    broadcastGameState() {
        const gameState = {
            type: 'gameState',
            totalPlayers: this.players.size,
            gameStarted: this.gameStarted,
            players: Array.from(this.players.entries()).map(([id, info]) => ({
                id,
                name: info.name,
                hasCards: info.cards.length > 0
            }))
        };

        const message = JSON.stringify(gameState);
        for (let [_, playerInfo] of this.players) {
            playerInfo.ws.send(message);
        }
    }

    endGame(hostId) {
        if (hostId !== this.hostId) {
            return { error: "방장만 게임을 종료할 수 있습니다." };
        }

        this.gameStarted = false;
        for (let [_, playerInfo] of this.players) {
            playerInfo.cards = [];
        }

        this.broadcastGameState();
        return { success: true, message: "게임이 종료되었습니다." };
    }

    removePlayer(playerId) {
        this.players.delete(playerId);
        
        // 방장이 나갔을 경우 새로운 방장 지정
        if (playerId === this.hostId && this.players.size > 0) {
            this.hostId = this.players.keys().next().value;
        }

        this.broadcastGameState();
    }
}

const game = new CardGame();

wss.on('connection', (ws) => {
    console.log('새로운 클라이언트가 연결되었습니다.');

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        switch (data.type) {
            case 'join':
                const joinResult = game.addPlayer(ws, data.playerId, data.playerName);
                ws.send(JSON.stringify({
                    type: 'joinResponse',
                    ...joinResult
                }));
                if (joinResult.success) {
                    game.broadcastGameState();
                }
                break;

            case 'start':
                const startResult = game.startGame(data.playerId);
                if (startResult.error) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: startResult.error
                    }));
                }
                break;

            case 'end':
                const endResult = game.endGame(data.playerId);
                if (endResult.error) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: endResult.error
                    }));
                }
                break;
        }
    });

    ws.on('close', () => {
        // 연결이 끊긴 플레이어 찾기
        for (let [playerId, playerInfo] of game.players) {
            if (playerInfo.ws === ws) {
                game.removePlayer(playerId);
                break;
            }
        }
    });
});

server.listen(5000, () => {
    console.log('서버가 5000번 포트에서 시작되었습니다.');
});