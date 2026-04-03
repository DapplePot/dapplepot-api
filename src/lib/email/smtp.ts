import nodemailer from 'nodemailer'
import type { EmailMessage, EmailProvider } from './index.js'

export class SmtpEmailProvider implements EmailProvider {
    private transporter: ReturnType<typeof nodemailer.createTransport>

    constructor(config: {
        host: string
        port: number
        user: string
        pass: string
        from: string
    }) {
        this.transporter = nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.port === 465,
            auth: { user: config.user, pass: config.pass },
        })
        this._from = config.from
    }

    private _from: string

    async send(msg: EmailMessage): Promise<void> {
        await this.transporter.sendMail({
            from: this._from,
            to: msg.to,
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
        })
    }
}
