use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::ptr;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{
    GetFinalPathNameByHandleW, MoveFileExW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

pub(crate) struct ChildJob {
    handle: HANDLE,
}

impl ChildJob {
    pub(crate) fn new(process_memory_limit_bytes: u64) -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error().to_string());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        limits.ProcessMemoryLimit = usize::try_from(process_memory_limit_bytes)
            .map_err(|_| "child memory limit does not fit usize".to_string())?;
        limits.JobMemoryLimit = limits.ProcessMemoryLimit;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .map_err(|_| "job limits size does not fit u32".to_string())?,
            )
        };
        if configured == 0 {
            let error = io::Error::last_os_error().to_string();
            unsafe {
                CloseHandle(handle);
            }
            return Err(error);
        }
        Ok(Self { handle })
    }

    pub(crate) fn assign(&self, child: &Child) -> Result<(), String> {
        let process = child.as_raw_handle() as HANDLE;
        let assigned = unsafe { AssignProcessToJobObject(self.handle, process) };
        if assigned == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok(())
    }
}

impl Drop for ChildJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

pub(crate) fn peak_current_working_set_bytes() -> Result<u64, String> {
    peak_working_set_bytes_for_handle(unsafe { GetCurrentProcess() })
}

pub(crate) fn peak_child_working_set_bytes(child: &Child) -> Result<u64, String> {
    peak_working_set_bytes_for_handle(child.as_raw_handle() as HANDLE)
}

fn peak_working_set_bytes_for_handle(process: HANDLE) -> Result<u64, String> {
    let mut counters = PROCESS_MEMORY_COUNTERS {
        cb: u32::try_from(size_of::<PROCESS_MEMORY_COUNTERS>())
            .map_err(|_| "PROCESS_MEMORY_COUNTERS size does not fit u32".to_string())?,
        ..PROCESS_MEMORY_COUNTERS::default()
    };
    let succeeded = unsafe { K32GetProcessMemoryInfo(process, &mut counters, counters.cb) };
    if succeeded == 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    u64::try_from(counters.PeakWorkingSetSize)
        .map_err(|_| "peak working-set size does not fit u64".to_string())
}

pub(crate) fn final_path_for_file(file: &File) -> Result<PathBuf, String> {
    let handle = file.as_raw_handle() as HANDLE;
    let mut buffer = vec![0_u16; 512];
    loop {
        let capacity = u32::try_from(buffer.len())
            .map_err(|_| "final-path buffer length does not fit u32".to_string())?;
        let length = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                buffer.as_mut_ptr(),
                capacity,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        };
        if length == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        let length = usize::try_from(length)
            .map_err(|_| "final path length does not fit usize".to_string())?;
        if length < buffer.len() {
            buffer.truncate(length);
            return Ok(PathBuf::from(OsString::from_wide(&buffer)));
        }
        buffer.resize(length.saturating_add(1), 0);
    }
}

pub(crate) fn path_is_within(root: &Path, candidate: &Path) -> bool {
    let root = comparable_windows_path(root);
    let candidate = comparable_windows_path(candidate);
    candidate == root
        || candidate
            .strip_prefix(&root)
            .is_some_and(|rest| rest.starts_with('\\'))
}

fn comparable_windows_path(path: &Path) -> String {
    let value = path.as_os_str().to_string_lossy().replace('/', "\\");
    let value = value
        .strip_prefix("\\\\?\\UNC\\")
        .map(|rest| format!("\\\\{rest}"))
        .or_else(|| value.strip_prefix("\\\\?\\").map(str::to_owned))
        .unwrap_or(value);
    value.trim_end_matches('\\').to_lowercase()
}

pub(crate) fn move_file_without_replacing(source: &Path, destination: &Path) -> io::Result<()> {
    let source = wide_path(source);
    let destination = wide_path(destination);
    let moved = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) };
    if moved == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
