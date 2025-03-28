-- AlterTable
ALTER TABLE "PlatformCredentials" ADD COLUMN     "access_token" TEXT,
ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "scopes" TEXT[];
