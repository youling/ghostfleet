#![no_std]
#![no_main]

use core::arch::asm;
use core::panic::PanicInfo;

const fn message() -> [u8; 22] {
    let total = 7 + 14 + 21;
    let mut line = *b"GhostFleet fixture 00\n";
    line[19] = b'0' + total / 10;
    line[20] = b'0' + total % 10;
    line
}

static OUTPUT: [u8; 22] = message();

#[unsafe(no_mangle)]
pub extern "C" fn _start() -> ! {
    unsafe {
        // Linux x86-64 write and exit keep this fixture independent of libc.
        asm!("syscall", in("rax") 1usize, in("rdi") 1usize, in("rsi") OUTPUT.as_ptr(),
             in("rdx") OUTPUT.len(), lateout("rcx") _, lateout("r11") _, options(nostack));
        asm!("syscall", in("rax") 60usize, in("rdi") 0usize, options(noreturn));
    }
}

#[panic_handler]
fn panic(_: &PanicInfo<'_>) -> ! {
    unsafe { asm!("syscall", in("rax") 60usize, in("rdi") 1usize, options(noreturn)); }
}
