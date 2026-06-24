const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// =====================================================
// CONSTANTES DEL JUEGO
// =====================================================
const GRID_SIZE = 5; // 5x5 puntos = 4x4 cuadros
const MAX_PLAYERS = 8;

// =====================================================
// ESTADO DE LAS SALAS
// =====================================================
const games = {};

// =====================================================
// FUNCIONES AUXILIARES
// =====================================================

function createInitialState() {
    const totalLines = (GRID_SIZE - 1) * GRID_SIZE * 2;
    const totalBoxes = (GRID_SIZE - 1) * (GRID_SIZE - 1);
    
    return {
        lines: Array(totalLines).fill(null).map(() => ({ placed: false, owner: null })),
        boxes: Array(totalBoxes).fill(null).map(() => ({ owner: null })),
        players: [],
        currentTurn: null,
        gameStarted: false,
        gameOver: false,
        maxPlayers: MAX_PLAYERS,
        turnIndex: 0
    };
}

function getBoxIndex(row, col) {
    return row * (GRID_SIZE - 1) + col;
}

function getLineIndex(type, row, col) {
    // type: 'horizontal' o 'vertical'
    const totalHorizontal = GRID_SIZE * (GRID_SIZE - 1);
    if (type === 'horizontal') {
        return row * (GRID_SIZE - 1) + col;
    } else {
        return totalHorizontal + row * GRID_SIZE + col;
    }
}

function checkBoxCompletion(game, lineIndex, lineType, row, col) {
    const completedBoxes = [];
    const boxes = game.boxes || [];
    const lines = game.lines || [];
    
    // Determinar qué cuadros pueden ser completados por esta línea
    const boxChecks = [];
    
    if (lineType === 'horizontal') {
        // La línea horizontal está en la fila `row`, entre col y col+1
        // Afecta al cuadro de arriba (row-1, col) y al de abajo (row, col)
        if (row > 0) {
            boxChecks.push({ row: row - 1, col: col });
        }
        if (row < GRID_SIZE - 1) {
            boxChecks.push({ row: row, col: col });
        }
    } else {
        // Línea vertical en la columna `col`, entre row y row+1
        // Afecta al cuadro de la izquierda (row, col-1) y al de la derecha (row, col)
        if (col > 0) {
            boxChecks.push({ row: row, col: col - 1 });
        }
        if (col < GRID_SIZE - 1) {
            boxChecks.push({ row: row, col: col });
        }
    }
    
    for (let check of boxChecks) {
        const { row: r, col: c } = check;
        if (r < 0 || r >= GRID_SIZE - 1 || c < 0 || c >= GRID_SIZE - 1) continue;
        
        const boxIdx = getBoxIndex(r, c);
        if (boxes[boxIdx] && boxes[boxIdx].owner !== null) continue;
        
        // Verificar las 4 líneas del cuadro
        const top = getLineIndex('horizontal', r, c);
        const bottom = getLineIndex('horizontal', r + 1, c);
        const left = getLineIndex('vertical', r, c);
        const right = getLineIndex('vertical', r, c + 1);
        
        if (lines[top] && lines[top].placed &&
            lines[bottom] && lines[bottom].placed &&
            lines[left] && lines[left].placed &&
            lines[right] && lines[right].placed) {
            completedBoxes.push(boxIdx);
        }
    }
    
    return completedBoxes;
}

function getNextPlayer(game) {
    const activePlayers = game.players.filter(p => p.connected);
    if (activePlayers.length === 0) return null;
    if (game.turnIndex >= activePlayers.length) game.turnIndex = 0;
    return activePlayers[game.turnIndex].id;
}

function advanceTurn(game) {
    const activePlayers = game.players.filter(p => p.connected);
    if (activePlayers.length === 0) return null;
    game.turnIndex = (game.turnIndex + 1) % activePlayers.length;
    return activePlayers[game.turnIndex].id;
}

function checkGameOver(game) {
    const boxes = game.boxes || [];
    return boxes.every(b => b.owner !== null);
}

function getWinner(game) {
    const players = game.players || [];
    let winner = null;
    let maxScore = -1;
    for (let p of players) {
        if (p.score > maxScore) {
            maxScore = p.score;
            winner = p;
        }
    }
    return winner;
}

function getGameState(gameId) {
    const game = games[gameId];
    if (!game) return null;
    
    // Calcular scores
    const boxes = game.boxes || [];
    const players = game.players || [];
    for (let p of players) {
        p.score = boxes.filter(b => b.owner === p.id).length;
    }
    
    return {
        players: players,
        lines: game.lines || [],
        boxes: game.boxes || [],
        currentTurn: game.currentTurn,
        gameStarted: game.gameStarted || false,
        gameOver: game.gameOver || false,
        maxPlayers: game.maxPlayers || MAX_PLAYERS,
        isHost: game.host || null
    };
}

// =====================================================
// SOCKET.IO
// =====================================================

io.on('connection', (socket) => {
    console.log(`🟢 Usuario conectado: ${socket.id}`);

    // =====================================================
    // CREAR SALA
    // =====================================================
    socket.on('createGame', (data) => {
        const { gameId, playerName, maxPlayers } = data;
        
        if (games[gameId]) {
            socket.emit('error', 'Ya existe una sala con ese código');
            return;
        }

        const game = createInitialState();
        game.host = socket.id;
        game.maxPlayers = maxPlayers || MAX_PLAYERS;
        
        const player = {
            id: socket.id,
            name: playerName || 'Anfitrión',
            score: 0,
            connected: true,
            index: 0
        };
        game.players.push(player);
        game.currentTurn = socket.id;
        game.turnIndex = 0;
        
        games[gameId] = game;
        socket.join(gameId);
        
        socket.emit('gameCreated', { gameId });
        io.to(gameId).emit('gameState', getGameState(gameId));
        io.to(gameId).emit('playersUpdate', game.players);
        io.to(gameId).emit('chatMessage', {
            player: 'Sistema',
            message: `${playerName || 'Anfitrión'} ha creado la sala`,
            system: true
        });
        
        console.log(`🏠 Sala ${gameId} creada por ${playerName}`);
    });

    // =====================================================
    // UNIRSE A SALA
    // =====================================================
    socket.on('joinGame', (data) => {
        const { gameId, playerName } = data;
        const game = games[gameId];
        
        if (!game) {
            socket.emit('error', 'La sala no existe');
            return;
        }
        
        if (game.players.length >= game.maxPlayers) {
            socket.emit('error', 'La sala está llena');
            return;
        }
        
        if (game.gameStarted) {
            socket.emit('error', 'La partida ya ha comenzado');
            return;
        }
        
        const existingPlayer = game.players.find(p => p.id === socket.id);
        if (existingPlayer) {
            existingPlayer.connected = true;
            existingPlayer.name = playerName || existingPlayer.name;
        } else {
            const player = {
                id: socket.id,
                name: playerName || 'Jugador',
                score: 0,
                connected: true,
                index: game.players.length
            };
            game.players.push(player);
        }
        
        socket.join(gameId);
        
        io.to(gameId).emit('gameState', getGameState(gameId));
        io.to(gameId).emit('playersUpdate', game.players);
        io.to(gameId).emit('chatMessage', {
            player: 'Sistema',
            message: `${playerName || 'Jugador'} se ha unido a la sala`,
            system: true
        });
        
        console.log(`👤 ${playerName} se unió a sala ${gameId}`);
    });

    // =====================================================
    // INICIAR PARTIDA
    // =====================================================
    socket.on('startGame', (data) => {
        const { gameId } = data;
        const game = games[gameId];
        
        if (!game) {
            socket.emit('error', 'La sala no existe');
            return;
        }
        
        if (socket.id !== game.host) {
            socket.emit('error', 'Solo el anfitrión puede iniciar la partida');
            return;
        }
        
        if (game.players.length < 2) {
            socket.emit('error', 'Se necesitan al menos 2 jugadores');
            return;
        }
        
        if (game.gameStarted) {
            socket.emit('error', 'La partida ya ha comenzado');
            return;
        }
        
        // Resetear juego
        const newState = createInitialState();
        game.lines = newState.lines;
        game.boxes = newState.boxes;
        game.gameStarted = true;
        game.gameOver = false;
        game.players.forEach(p => p.score = 0);
        game.turnIndex = 0;
        game.currentTurn = game.players[0].id;
        
        io.to(gameId).emit('gameStarted', { firstTurn: game.currentTurn });
        io.to(gameId).emit('gameState', getGameState(gameId));
        io.to(gameId).emit('playersUpdate', game.players);
        io.to(gameId).emit('chatMessage', {
            player: 'Sistema',
            message: '🎮 ¡La partida ha comenzado!',
            system: true
        });
        
        console.log(`🎮 Partida iniciada en sala ${gameId}`);
    });

    // =====================================================
    // COLOCAR LÍNEA
    // =====================================================
    socket.on('placeLine', (data) => {
        const { gameId, line } = data;
        const game = games[gameId];
        
        if (!game) {
            socket.emit('error', 'La sala no existe');
            return;
        }
        
        if (!game.gameStarted || game.gameOver) {
            socket.emit('error', 'El juego no está activo');
            return;
        }
        
        if (game.currentTurn !== socket.id) {
            socket.emit('error', 'No es tu turno');
            return;
        }
        
        const { type, row, col, index } = line;
        const lines = game.lines || [];
        
        if (index >= lines.length || lines[index].placed) {
            socket.emit('error', 'Esta línea ya está colocada');
            return;
        }
        
        // Colocar la línea
        lines[index].placed = true;
        lines[index].owner = socket.id;
        
        // Verificar si se completaron cuadros
        const completedBoxes = checkBoxCompletion(game, index, type, row, col);
        let extraTurn = false;
        
        if (completedBoxes.length > 0) {
            extraTurn = true;
            for (let boxIdx of completedBoxes) {
                game.boxes[boxIdx].owner = socket.id;
            }
            // Actualizar scores
            const player = game.players.find(p => p.id === socket.id);
            if (player) {
                player.score += completedBoxes.length;
            }
        }
        
        // Verificar si el juego terminó
        const gameOver = checkGameOver(game);
        if (gameOver) {
            game.gameOver = true;
            game.gameStarted = false;
            const winner = getWinner(game);
            io.to(gameId).emit('linePlaced', {
                lines: game.lines,
                boxes: game.boxes,
                players: game.players,
                nextTurn: null,
                completedBoxes: completedBoxes,
                gameOver: true,
                winner: winner
            });
            io.to(gameId).emit('gameFinished', { winner: winner });
            io.to(gameId).emit('chatMessage', {
                player: 'Sistema',
                message: `🏆 ${winner.name} ha ganado la partida con ${winner.score} puntos!`,
                system: true
            });
            io.to(gameId).emit('gameState', getGameState(gameId));
            return;
        }
        
        // Avanzar turno
        let nextTurn;
        if (extraTurn) {
            nextTurn = socket.id; // El mismo jugador sigue
        } else {
            nextTurn = advanceTurn(game);
            game.currentTurn = nextTurn;
        }
        
        io.to(gameId).emit('linePlaced', {
            lines: game.lines,
            boxes: game.boxes,
            players: game.players,
            nextTurn: nextTurn,
            completedBoxes: completedBoxes,
            gameOver: false,
            winner: null
        });
        io.to(gameId).emit('gameState', getGameState(gameId));
        io.to(gameId).emit('playersUpdate', game.players);
        
        if (completedBoxes.length > 0) {
            const player = game.players.find(p => p.id === socket.id);
            io.to(gameId).emit('chatMessage', {
                player: 'Sistema',
                message: `📦 ${player.name} cerró ${completedBoxes.length} cuadro(s)!`,
                system: true
            });
        }
    });

    // =====================================================
    // REINICIAR PARTIDA
    // =====================================================
    socket.on('resetGame', (data) => {
        const { gameId } = data;
        const game = games[gameId];
        
        if (!game) {
            socket.emit('error', 'La sala no existe');
            return;
        }
        
        if (socket.id !== game.host) {
            socket.emit('error', 'Solo el anfitrión puede reiniciar');
            return;
        }
        
        const newState = createInitialState();
        game.lines = newState.lines;
        game.boxes = newState.boxes;
        game.gameStarted = true;
        game.gameOver = false;
        game.players.forEach(p => p.score = 0);
        game.turnIndex = 0;
        game.currentTurn = game.players[0].id;
        
        io.to(gameId).emit('gameReset', {
            lines: game.lines,
            boxes: game.boxes,
            players: game.players,
            firstTurn: game.currentTurn
        });
        io.to(gameId).emit('gameState', getGameState(gameId));
        io.to(gameId).emit('playersUpdate', game.players);
        io.to(gameId).emit('chatMessage', {
            player: 'Sistema',
            message: '🔄 Partida reiniciada por el anfitrión',
            system: true
        });
        
        console.log(`🔄 Partida reiniciada en sala ${gameId}`);
    });

    // =====================================================
    // FINALIZAR PARTIDA
    // =====================================================
    socket.on('finishGame', (data) => {
        const { gameId } = data;
        const game = games[gameId];
        
        if (!game) {
            socket.emit('error', 'La sala no existe');
            return;
        }
        
        if (socket.id !== game.host) {
            socket.emit('error', 'Solo el anfitrión puede finalizar');
            return;
        }
        
        game.gameStarted = false;
        game.gameOver = true;
        const winner = getWinner(game);
        
        io.to(gameId).emit('gameFinished', { winner: winner });
        io.to(gameId).emit('gameState', getGameState(gameId));
        io.to(gameId).emit('chatMessage', {
            player: 'Sistema',
            message: `🏁 Partida finalizada por el anfitrión. Ganador: ${winner.name} con ${winner.score} puntos!`,
            system: true
        });
        
        console.log(`🏁 Partida finalizada en sala ${gameId}`);
    });

    // =====================================================
    // CHAT
    // =====================================================
    socket.on('chatMessage', (data) => {
        const { gameId, message } = data;
        const game = games[gameId];
        if (!game) return;
        
        const player = game.players.find(p => p.id === socket.id);
        if (!player) return;
        
        io.to(gameId).emit('chatMessage', {
            player: player.name,
            message: message,
            system: false,
            timestamp: Date.now()
        });
    });

    // =====================================================
    // DESCONEXIÓN
    // =====================================================
    socket.on('disconnect', () => {
        console.log(`🔴 Usuario desconectado: ${socket.id}`);
        
        for (const [gameId, game] of Object.entries(games)) {
            const playerIndex = game.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                game.players[playerIndex].connected = false;
                
                io.to(gameId).emit('playersUpdate', game.players);
                io.to(gameId).emit('chatMessage', {
                    player: 'Sistema',
                    message: `⚠️ ${game.players[playerIndex].name} se ha desconectado`,
                    system: true
                });
                
                // Si el anfitrión se desconecta, transferir host
                if (game.host === socket.id) {
                    const newHost = game.players.find(p => p.id !== socket.id && p.connected);
                    if (newHost) {
                        game.host = newHost.id;
                        io.to(gameId).emit('chatMessage', {
                            player: 'Sistema',
                            message: `👑 ${newHost.name} es ahora el anfitrión`,
                            system: true
                        });
                    }
                }
                
                // Si no quedan jugadores conectados, eliminar sala
                const activePlayers = game.players.filter(p => p.connected);
                if (activePlayers.length === 0) {
                    delete games[gameId];
                    console.log(`🗑️ Sala ${gameId} eliminada (sin jugadores)`);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor Dots and Boxes corriendo en http://localhost:${PORT}`);
});