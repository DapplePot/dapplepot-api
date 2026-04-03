import { Resend } from 'resend'
import type { EmailMessage, EmailProvider } from './index.js'

export class ResendEmailProvider implements EmailProvider {
    private client: Resend
    private from: string

    constructor(config: { apiKey: string; from: string }) {
        this.client = new Resend(config.apiKey)
        this.from = config.from
    }

    async send(msg: EmailMessage): Promise<void> {
        await this.client.emails.send({
            from: this.from,
            to: msg.to,
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
        })
    }
}
