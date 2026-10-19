import React from 'react'
import Loginform from "@/lib/forms/login";
import { Metadata } from 'next';
import { ModeToggle } from '@/components/themes/toggle';


export const metadata: Metadata = {
  title: "Xi | Login",
  description: "Welcome back !",
};
export default function page() {
  return (
    <>
     <div className=''>
      <Loginform/> 
      <div className="fixed top-4 right-4">
              <ModeToggle />
            </div>
     </div>
    </>
  )
}
