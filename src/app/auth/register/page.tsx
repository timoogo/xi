import { ModeToggle } from '@/components/themes/toggle';
import RegisterForm from '@/lib/forms/register'
import { Metadata } from 'next';
import React from 'react'

export const metadata: Metadata = {
  title: "Xi | Register",
  description: "Join to our infinite world",
};
export default function page() {
  return (
    <div>
    <RegisterForm/>
     <div className="fixed top-4 right-4">
             <ModeToggle />
           </div>
    </div>
  )
}
