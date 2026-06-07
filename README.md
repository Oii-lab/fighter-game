# DUEL — 1v1 Platform Fighter

> 即時連線平台格鬥遊戲，兩人同房間開打。

🎮 **[Play Now → fighter-game-b6j4.onrender.com](https://fighter-game-b6j4.onrender.com)**

---

## 玩法

1. 進入網站，輸入任意 Room ID
2. 傳 Room ID 給對手，對手輸入同一個 ID 加入
3. 兩人到齊後自動開始

## 操作鍵

| 動作 | 鍵盤 |
|------|------|
| 移動 | `A` / `D` |
| 跳躍（二段跳） | `W` / `Space` |
| 射擊 | `J` / `Z` |
| 衝刺 | `K` / `X` |

## 規則

- HP 歸零或被打落平台即判負
- 衝刺期間短暫無敵
- 每局結束按 **REMATCH** 重開

## 技術架構

- **後端**：Node.js + Socket.io（Server Authoritative，所有遊戲邏輯在 server 計算）
- **前端**：純 HTML / CSS / Canvas
- **部署**：Render.com

## 本地執行

```bash
npm install
node server/index.js
```

開啟 `http://localhost:3000`，兩個分頁輸入同一個 Room ID 即可測試。
