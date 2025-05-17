-- AlterTable
ALTER TABLE "LinkedInPage" ADD COLUMN     "address" JSONB,
ADD COLUMN     "coverPhoto" JSONB,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "logo" JSONB,
ADD COLUMN     "specialties" TEXT[],
ADD COLUMN     "staffCount" TEXT,
ADD COLUMN     "websiteURL" TEXT;
