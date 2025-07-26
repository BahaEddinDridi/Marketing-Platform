-- CreateTable
CREATE TABLE "MetaAccount" (
    "orgId" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "businessManagerId" TEXT NOT NULL,
    "descriptiveName" TEXT,
    "currencyCode" TEXT,
    "timeZone" TEXT,
    "adAccounts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaAccount_orgId_businessManagerId_key" ON "MetaAccount"("orgId", "businessManagerId");

-- AddForeignKey
ALTER TABLE "MetaAccount" ADD CONSTRAINT "MetaAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
