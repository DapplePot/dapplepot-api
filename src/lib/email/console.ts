import type { EmailMessage, EmailProvider } from './index.js'

export class ConsoleEmailProvider implements EmailProvider {
    async send(msg: EmailMessage): Promise<void> {
        console.log('\n╔══════════════════════════════════════════╗')
        console.log('║           EMAIL (console mode)           ║')
        console.log('╠══════════════════════════════════════════╣')
        console.log(`║ To:      ${msg.to}`)
        console.log(`║ Subject: ${msg.subject}`)
        console.log('╠══════════════════════════════════════════╣')
        console.log(msg.text)
        console.log('╚══════════════════════════════════════════╝\n')
    }
}
