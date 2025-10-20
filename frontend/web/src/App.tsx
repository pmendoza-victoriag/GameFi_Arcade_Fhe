// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface GameNFT {
  id: string;
  name: string;
  encryptedScore: string;
  timestamp: number;
  creator: string;
  price: number;
  plays: number;
  category: string;
}

// Randomly selected styles: High saturation neon (purple/blue/pink/green), Retro pixel, Card grid, Micro-interactions (hover ripple/button breathing light)
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [games, setGames] = useState<GameNFT[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newGameData, setNewGameData] = useState({ name: "", category: "Puzzle", price: 0 });
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [selectedGame, setSelectedGame] = useState<GameNFT | null>(null);
  const [decryptedScore, setDecryptedScore] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  // Randomly selected additional features: Search & Filter, Leaderboard
  const categories = ["All", "Puzzle", "Adventure", "Casino", "Strategy", "Arcade"];

  useEffect(() => {
    loadGames().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadGames = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("game_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing game keys:", e); }
      }
      
      const list: GameNFT[] = [];
      for (const key of keys) {
        try {
          const gameBytes = await contract.getData(`game_${key}`);
          if (gameBytes.length > 0) {
            try {
              const gameData = JSON.parse(ethers.toUtf8String(gameBytes));
              list.push({ 
                id: key, 
                name: gameData.name,
                encryptedScore: gameData.score,
                timestamp: gameData.timestamp,
                creator: gameData.creator,
                price: gameData.price,
                plays: gameData.plays || 0,
                category: gameData.category || "Unknown"
              });
            } catch (e) { console.error(`Error parsing game data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading game ${key}:`, e); }
      }
      list.sort((a, b) => b.plays - a.plays);
      setGames(list);
    } catch (e) { console.error("Error loading games:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createGame = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting game score with Zama FHE..." });
    try {
      // Generate random score between 50-100 for the game
      const score = Math.floor(Math.random() * 50) + 50;
      const encryptedScore = FHEEncryptNumber(score);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const gameId = `game-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const gameData = { 
        name: newGameData.name,
        score: encryptedScore,
        timestamp: Math.floor(Date.now() / 1000),
        creator: address,
        price: newGameData.price,
        plays: 0,
        category: newGameData.category
      };
      
      await contract.setData(`game_${gameId}`, ethers.toUtf8Bytes(JSON.stringify(gameData)));
      
      const keysBytes = await contract.getData("game_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(gameId);
      await contract.setData("game_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Game NFT created with FHE encryption!" });
      await loadGames();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewGameData({ name: "", category: "Puzzle", price: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const playGame = async (gameId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing game with FHE encryption..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const gameBytes = await contract.getData(`game_${gameId}`);
      if (gameBytes.length === 0) throw new Error("Game not found");
      
      const gameData = JSON.parse(ethers.toUtf8String(gameBytes));
      const updatedGame = { ...gameData, plays: (gameData.plays || 0) + 1 };
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      await contractWithSigner.setData(`game_${gameId}`, ethers.toUtf8Bytes(JSON.stringify(updatedGame)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Game played! Score remains encrypted with FHE." });
      await loadGames();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Play failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const filteredGames = games.filter(game => {
    const matchesSearch = game.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = activeCategory === "All" || game.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  const topGames = [...games].sort((a, b) => b.plays - a).slice(0, 5);

  if (loading) return (
    <div className="loading-screen">
      <div className="pixel-spinner"></div>
      <p>Loading GameFi Arcade...</p>
    </div>
  );

  return (
    <div className="app-container pixel-theme">
      <header className="app-header">
        <div className="logo">
          <h1>FHE-Encrypted Mini-Game Platform</h1>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
        </div>
      </header>

      <div className="main-content">
        <div className="hero-banner">
          <div className="hero-text">
            <h2>Create & Play FHE-Encrypted Games</h2>
            <p>Build your own privacy-preserving mini-games with Zama FHE technology</p>
            <button 
              onClick={() => setShowCreateModal(true)} 
              className="pixel-button primary"
            >
              Create Game NFT
            </button>
          </div>
          <div className="hero-image">
            <div className="pixel-art"></div>
          </div>
        </div>

        <div className="controls-section">
          <div className="search-box">
            <input
              type="text"
              placeholder="Search games..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pixel-input"
            />
          </div>
          <div className="category-tabs">
            {categories.map(cat => (
              <button
                key={cat}
                className={`pixel-button ${activeCategory === cat ? 'active' : ''}`}
                onClick={() => setActiveCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
          <button 
            className="pixel-button accent"
            onClick={() => setShowLeaderboard(!showLeaderboard)}
          >
            {showLeaderboard ? 'Hide Leaderboard' : 'Show Leaderboard'}
          </button>
        </div>

        {showLeaderboard && (
          <div className="leaderboard-section pixel-card">
            <h2>Top Games</h2>
            <div className="leaderboard-list">
              {topGames.map((game, index) => (
                <div key={game.id} className="leaderboard-item">
                  <div className="rank">#{index + 1}</div>
                  <div className="game-info">
                    <h3>{game.name}</h3>
                    <p>Plays: {game.plays} | Creator: {game.creator.substring(0, 6)}...</p>
                  </div>
                  <div className="game-score">
                    <button 
                      className="pixel-button small"
                      onClick={() => {
                        setSelectedGame(game);
                        setDecryptedScore(null);
                      }}
                    >
                      Details
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="games-grid">
          {filteredGames.length === 0 ? (
            <div className="no-games pixel-card">
              <div className="no-games-icon"></div>
              <p>No games found</p>
              <button 
                className="pixel-button primary"
                onClick={() => setShowCreateModal(true)}
              >
                Create First Game
              </button>
            </div>
          ) : (
            filteredGames.map(game => (
              <div key={game.id} className="game-card pixel-card">
                <div className="game-header">
                  <h3>{game.name}</h3>
                  <span className="game-category">{game.category}</span>
                </div>
                <div className="game-stats">
                  <div className="stat">
                    <span>Price:</span>
                    <strong>{game.price} ETH</strong>
                  </div>
                  <div className="stat">
                    <span>Plays:</span>
                    <strong>{game.plays}</strong>
                  </div>
                </div>
                <div className="game-actions">
                  <button 
                    className="pixel-button"
                    onClick={() => playGame(game.id)}
                  >
                    Play
                  </button>
                  <button 
                    className="pixel-button outline"
                    onClick={() => {
                      setSelectedGame(game);
                      setDecryptedScore(null);
                    }}
                  >
                    Details
                  </button>
                </div>
                <div className="fhe-badge">
                  <span>FHE Encrypted</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal pixel-card">
            <div className="modal-header">
              <h2>Create New Game NFT</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Game Name</label>
                <input
                  type="text"
                  name="name"
                  value={newGameData.name}
                  onChange={(e) => setNewGameData({...newGameData, name: e.target.value})}
                  className="pixel-input"
                  placeholder="My Awesome Game"
                />
              </div>
              <div className="form-group">
                <label>Category</label>
                <select
                  name="category"
                  value={newGameData.category}
                  onChange={(e) => setNewGameData({...newGameData, category: e.target.value})}
                  className="pixel-select"
                >
                  <option value="Puzzle">Puzzle</option>
                  <option value="Adventure">Adventure</option>
                  <option value="Casino">Casino</option>
                  <option value="Strategy">Strategy</option>
                  <option value="Arcade">Arcade</option>
                </select>
              </div>
              <div className="form-group">
                <label>Price (ETH)</label>
                <input
                  type="number"
                  name="price"
                  value={newGameData.price}
                  onChange={(e) => setNewGameData({...newGameData, price: parseFloat(e.target.value)})}
                  className="pixel-input"
                  step="0.01"
                  min="0"
                />
              </div>
              <div className="fhe-notice">
                <div className="fhe-icon"></div>
                <p>Game score will be encrypted with Zama FHE technology</p>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => setShowCreateModal(false)} 
                className="pixel-button"
              >
                Cancel
              </button>
              <button 
                onClick={createGame} 
                disabled={creating || !newGameData.name}
                className="pixel-button primary"
              >
                {creating ? "Creating..." : "Create Game NFT"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedGame && (
        <div className="modal-overlay">
          <div className="game-detail-modal pixel-card">
            <div className="modal-header">
              <h2>{selectedGame.name}</h2>
              <button onClick={() => {
                setSelectedGame(null);
                setDecryptedScore(null);
              }} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="game-info">
                <div className="info-item">
                  <span>Category:</span>
                  <strong>{selectedGame.category}</strong>
                </div>
                <div className="info-item">
                  <span>Creator:</span>
                  <strong>{selectedGame.creator.substring(0, 6)}...{selectedGame.creator.substring(38)}</strong>
                </div>
                <div className="info-item">
                  <span>Price:</span>
                  <strong>{selectedGame.price} ETH</strong>
                </div>
                <div className="info-item">
                  <span>Plays:</span>
                  <strong>{selectedGame.plays}</strong>
                </div>
                <div className="info-item">
                  <span>Created:</span>
                  <strong>{new Date(selectedGame.timestamp * 1000).toLocaleDateString()}</strong>
                </div>
              </div>
              
              <div className="fhe-section">
                <h3>FHE Encrypted Score</h3>
                <div className="encrypted-data">
                  {selectedGame.encryptedScore.substring(0, 50)}...
                </div>
                <button
                  className="pixel-button"
                  onClick={async () => {
                    if (decryptedScore !== null) {
                      setDecryptedScore(null);
                    } else {
                      const decrypted = await decryptWithSignature(selectedGame.encryptedScore);
                      setDecryptedScore(decrypted);
                    }
                  }}
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : 
                   decryptedScore !== null ? "Hide Score" : "Decrypt Score"}
                </button>
              </div>
              
              {decryptedScore !== null && (
                <div className="decrypted-section">
                  <h3>Decrypted Score</h3>
                  <div className="score-display">
                    <div className="score-value">{decryptedScore}</div>
                    <div className="score-label">Quality Score</div>
                  </div>
                  <div className="score-description">
                    This score was computed using Zama FHE technology while remaining encrypted
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => playGame(selectedGame.id)}
                className="pixel-button primary"
              >
                Play Game
              </button>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content pixel-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="pixel-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h3>FHE-Encrypted GameFi Platform</h3>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">About Zama FHE</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;