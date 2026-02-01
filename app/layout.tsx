import React from "react"
import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

const _geist = Geist({ subsets: ["latin"] });
const _geistMono = Geist_Mono({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: 'Collaborative Canvas - Real-time Drawing',
  description: 'A multi-user drawing application where multiple people can draw simultaneously on the same canvas with real-time synchronization.',
  icons: {
    icon: [
      {
        url: '/favicon.png',
        type: 'image/png',
      }
    ],
    apple: {
      url: '/favicon.png',
      type: 'image/png',
    },
    shortcut: '/favicon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.png" type="image/png" sizes="any" />
        <link rel="apple-touch-icon" href="/favicon.png" />
        <meta name="theme-color" content="#ffffff" />
      </head>
      <body className={`font-sans antialiased`}>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
