# CoinFlip on Ark

inspired by https://arxiv.org/pdf/1612.05390v3

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

## Project Structure

```
├── src/
│   ├── assets/        # Static assets
│   ├── components/    # Vue components
│   ├── utils/         # Utility functions
│   ├── views/         # Views
│   ├── store/         # Vuex store
│   ├── router/        # Vue router
│   ├── App.vue        # Main chat interface
│   └── main.js        # Application entry point
├── public/
│   └── index.html     # HTML template
├── babel.config.js    # Babel configuration
└── package.json       # Project dependencies and scripts
```

## Scripts

- `npm run serve`: Start development server
- `npm run build`: Build for production
- `npm run lint`: Lint and fix files

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License

Copyright (c) 2024 CoinFlip developers

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
