-- CreateTable
CREATE TABLE "LinkedInPage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vanityName" TEXT,
    "logoUrl" TEXT,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInPage_pageId_key" ON "LinkedInPage"("pageId");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInPage_organizationId_pageId_key" ON "LinkedInPage"("organizationId", "pageId");

-- AddForeignKey
ALTER TABLE "LinkedInPage" ADD CONSTRAINT "LinkedInPage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
