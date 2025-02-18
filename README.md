# CoinFlip

CoinFlip is a decentralized & trustless Bitcoin gambling game built on Ark and Nostr protocols. Players can create or join games with customizable bet amounts, competing head-to-head in a provably fair coin flip. 

![Main page](screenshots/mainpage.png)
*Browse available games and create new ones*

![Game page](screenshots/game.png)
*View game details and play*

## How it works

CoinFlip uses Bitcoin's Taproot and Ark capabilities to create a trustless coin flip game between two players. The game mechanics are based on secret generation of predetermined sizes (15 bytes for "Heads", 16 bytes for "Tails").

The game is completely trustless - neither player can cheat or withhold funds once committed. For detailed technical explanation, visit: https://coinflip.casino/how-it-works

## Prerequisites

- Node.js (v14 or higher recommended)
- npm or yarn

## Installation

1. Install dependencies:

```bash
npm install
# or
yarn install
```

2. Run the development server:

```bash
npm run serve
# or
yarn serve
```

The application will be available at `http://localhost:8080`

## License

MIT License

Copyright (c) 2024 ArkLabs developers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
