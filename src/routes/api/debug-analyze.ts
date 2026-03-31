/**
 * Debug Analyze API — sends terminal output to Hermes for AI diagnosis.
 * Returns suggested commands and root cause analysis.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'

const HERMES_API_URL = process.env.HERMES_API_URL || 'http://127.0.0.1:8642'

type DebugCommand = {
  command: string
  description: string
}

type DebugAnalysisResult = {
  summary: string
  rootCause: string
  suggestedCommands: Array<DebugCommand>
  docsLink?: string
}

function buildPrompt(terminalOutput: string): string {
  return `You are a terminal debugging assistant. Analyze the following terminal output and provide a concise diagnosis.

Terminal output:
\`\`\`
${terminalOutput.slice(0, 4000)}
\`\`\`

Respond with JSON in this exact format:
{
  "summary": "One sentence summary of what happened",
  "rootCause": "The most likely root cause",
  "suggestedCommands": [
    { "command": "exact command to run", "description": "what it does" }
  ]
}

Keep it practical. Max 3 suggested commands. If there's no obvious error, say so briefly.`
}

export const Route = createFileRoute('/api/debug-analyze')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const terminalOutput = typeof body.terminalOutput === 'string'
          ? body.terminalOutput.trim()
          : ''

        if (!terminalOutput) {
          return json<DebugAnalysisResult>({
            summary: 'No terminal output to analyze.',
            rootCause: 'The terminal buffer appears to be empty.',
            suggestedCommands: [],
          })
        }

        try {
          // Use Hermes chat API for analysis
          const response = await fetch(`${HERMES_API_URL}/api/sessions/debug_analyze_tmp/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: buildPrompt(terminalOutput),
              model: null, // use default
            }),
          })

          if (!response.ok) {
            throw new Error(`Hermes API error: ${response.status}`)
          }

          const data = (await response.json()) as { response?: string; content?: string }
          const raw = data.response ?? data.content ?? ''

          // Extract JSON from the response
          const jsonMatch = raw.match(/\{[\s\S]*\}/)
          if (!jsonMatch) {
            throw new Error('No JSON in response')
          }

          const parsed = JSON.parse(jsonMatch[0]) as Partial<DebugAnalysisResult>

          return json<DebugAnalysisResult>({
            summary: parsed.summary ?? 'Analysis complete.',
            rootCause: parsed.rootCause ?? 'See summary above.',
            suggestedCommands: Array.isArray(parsed.suggestedCommands)
              ? parsed.suggestedCommands
              : [],
          })
        } catch (err) {
          // Fallback: basic pattern matching if LLM unavailable
          const output = terminalOutput.toLowerCase()
          const result: DebugAnalysisResult = {
            summary: 'Could not reach Hermes for AI analysis.',
            rootCause: 'LLM analysis unavailable — see common patterns below.',
            suggestedCommands: [],
          }

          if (output.includes('permission denied')) {
            result.summary = 'Permission denied error detected.'
            result.rootCause = 'Insufficient file or directory permissions.'
            result.suggestedCommands = [
              { command: 'ls -la', description: 'Check file permissions' },
              { command: 'sudo !!', description: 'Retry last command with sudo' },
            ]
          } else if (output.includes('command not found') || output.includes('not found')) {
            result.summary = 'Command not found.'
            result.rootCause = 'The command is not installed or not in PATH.'
            result.suggestedCommands = [
              { command: 'which <command>', description: 'Check if command exists' },
              { command: 'echo $PATH', description: 'Check PATH variable' },
            ]
          } else if (output.includes('no such file') || output.includes('cannot find')) {
            result.summary = 'File or directory not found.'
            result.rootCause = 'The specified path does not exist.'
            result.suggestedCommands = [
              { command: 'ls -la', description: 'List files in current directory' },
              { command: 'pwd', description: 'Show current working directory' },
            ]
          } else if (output.includes('connection refused') || output.includes('connection timed out')) {
            result.summary = 'Network connection failed.'
            result.rootCause = 'Service is not running or port is blocked.'
            result.suggestedCommands = [
              { command: 'ss -tlnp', description: 'List listening ports' },
              { command: 'systemctl status', description: 'Check service status' },
            ]
          }

          return json(result)
        }
      },
    },
  },
})
