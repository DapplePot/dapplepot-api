export interface LoginRequest {
    email: string
    password: string
}

export interface LoginResponse {
    accessToken: string
    refreshToken: string
    expiresIn: number
    user: UserSummary
}

export interface UserSummary {
    userId: string
    tenantId: string | null
    email: string
    name: string
    role: 'superadmin' | 'admin' | 'editor' | 'viewer'
    status: 'active' | 'disabled'
    createdAt: string
    emailVerifiedAt: string | null
}

export interface InviteSummary {
    inviteId: string
    email: string
    role: 'admin' | 'editor' | 'viewer'
    status: 'pending' | 'accepted' | 'expired' | 'revoked'
    invitedBy: string
    createdAt: string
    expiresAt: string
}

export interface InviteRequest {
    email: string
    role: 'admin' | 'editor' | 'viewer'
}

export interface AcceptInviteRequest {
    token: string
    name: string
    password: string
}

export interface ForgotPasswordRequest {
    email: string
}

export interface ResetPasswordRequest {
    token: string
    password: string
}

export interface UpdateProfileRequest {
    name?: string
    currentPassword?: string
    newPassword?: string
}

export interface ChangeRoleRequest {
    role: 'admin' | 'editor' | 'viewer'
}

export interface ChangeStatusRequest {
    status: 'active' | 'disabled'
}
