# Contributing to Inworld Mastra Design Agent

Thank you for your interest in contributing! This document covers how to set up the project and submit changes.

## Getting Started

### Prerequisites

- Node.js (v20 or higher)
- npm
- Git
- An [Inworld AI](https://platform.inworld.ai/) account and API key

### Development Setup

1. **Fork the repository** on GitHub.

2. **Clone your fork**:

   ```bash
   git clone https://github.com/YOUR_USERNAME/inworld-mastra-design-agent.git
   cd inworld-mastra-design-agent
   ```

3. **Install dependencies**:

   ```bash
   npm install
   ```

4. **Set up environment variables**:

   ```bash
   cp .env.example .env
   # then paste your INWORLD_API_KEY
   ```

5. **Run it**:

   ```bash
   npm run dev   # http://localhost:4111
   ```

## Development Workflow

1. **Create a branch**: `git checkout -b feature/your-feature` or `fix/your-bug`.

2. **Make your changes** and test them locally.

3. **Run the checks** before committing:

   ```bash
   npm run typecheck      # TypeScript types
   npm run format:check   # Prettier formatting (use `npm run format` to auto-fix)
   ```

4. **Commit** with a clear, descriptive message explaining what and why.

## Code Style

- TypeScript strict mode; provide explicit types and avoid `any`.
- ESM modules (`"type": "module"`).
- Code is formatted with [Prettier](https://prettier.io/) — run `npm run format` before committing.
- Match the existing patterns in the file you're editing.

## Pull Request Process

1. Push your branch to your fork and open a Pull Request against `main`.
2. Keep the PR focused on a single change; link any related issues.
3. Ensure `npm run typecheck` and `npm run format:check` pass.
4. Address review feedback and keep commits clean and logical.

## Reporting Issues

When reporting a bug, please include a clear title, steps to reproduce, expected vs. actual behavior, and your environment (Node.js version, OS). For feature requests, describe the use case and motivation.

- **GitHub Issues**: [Open an issue](https://github.com/inworld-ai/inworld-mastra-design-agent/issues)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
