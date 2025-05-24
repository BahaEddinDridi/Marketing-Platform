-- AlterTable
ALTER TABLE "LeadConfiguration" ADD COLUMN     "excludedEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "specialEmails" TEXT[] DEFAULT ARRAY[]::TEXT[];
