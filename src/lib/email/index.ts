import { env } from '../../env.js'
import { ConsoleEmailProvider } from './console.js'
import { SmtpEmailProvider } from './smtp.js'
import { ResendEmailProvider } from './resend.js'

export interface EmailMessage {
    to: string
    subject: string
    html: string
    text: string
}

export interface EmailProvider {
    send(message: EmailMessage): Promise<void>
}

export function createEmailProvider(): EmailProvider {
    switch (env.DAPPLEPOT_EMAIL_PROVIDER) {
        case 'smtp':
            if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_USER || !env.SMTP_PASS) {
                throw new Error('SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS are required when DAPPLEPOT_EMAIL_PROVIDER=smtp')
            }
            return new SmtpEmailProvider({
                host: env.SMTP_HOST,
                port: env.SMTP_PORT,
                user: env.SMTP_USER,
                pass: env.SMTP_PASS,
                from: env.DAPPLEPOT_EMAIL_FROM,
            })
        case 'resend':
            return new ResendEmailProvider({
                apiKey: env.RESEND_API_KEY!,
                from: env.DAPPLEPOT_EMAIL_FROM,
            })
        default:
            return new ConsoleEmailProvider()
    }
}

export const emailProvider = createEmailProvider()
