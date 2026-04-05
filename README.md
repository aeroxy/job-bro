# Job Bro

AI-powered LinkedIn job posting analyzer Chrome extension.

## Features

- 🤖 AI-powered job posting analysis
- 📊 Analyze job postings directly on LinkedIn
- 🎨 Modern UI with side panel interface
- ⚡ Built with React and Tailwind CSS

## Development

### Prerequisites

- [Bun](https://bun.sh/) installed

### Installation

```bash
bun install
```

### Development Server

```bash
bun run dev
```

This will start the development server with hot reload enabled.

### Build

Build the extension for production:

```bash
bun run build
```

The built extension will be in `.output/chrome-mv3/`.

### Package

Create a packaged `.crx` file ready for distribution:

```bash
bun run package
```

This will build and package the extension as `.output/job-bro.crx`.

## Loading the Extension

### Development Mode

1. Run `bun run dev`
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `.output/chrome-mv3` directory

### Production Build

1. Run `bun run package`
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode"
4. Drag and drop `.output/job-bro.crx` onto the extensions page

## Tech Stack

- [WXT](https://wxt.dev/) - Chrome extension framework
- [React](https://react.dev/) - UI library
- [Tailwind CSS](https://tailwindcss.com/) - Styling
- [Radix UI](https://www.radix-ui.com/) - UI components
- [Lucide React](https://lucide.dev/) - Icons
- [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) - Local storage

## Project Structure

```
job-bro/
├── src/               # Source code
├── public/            # Static assets
├── .output/           # Build output
├── components.json    # Component configuration
└── wxt.config.ts     # WXT configuration
```

## Scripts

- `bun run dev` - Start development server
- `bun run build` - Build for production
- `bun run zip` - Create a zip file of the extension
- `bun run package` - Build and package as .crx file

## License

MIT
