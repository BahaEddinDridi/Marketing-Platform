-- AlterTable
ALTER TABLE "AdAccount" ADD COLUMN     "currency" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "servingStatuses" TEXT[],
ADD COLUMN     "status" TEXT,
ADD COLUMN     "test" BOOLEAN,
ADD COLUMN     "type" TEXT;
