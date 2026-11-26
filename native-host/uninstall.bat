@echo off
echo Uninstalling VideoGrabber native host from registry...

reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.videograbber.host"    /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.videograbber.host"   /f >nul 2>&1
reg delete "HKCU\Software\Opera Software\NativeMessagingHosts\com.videograbber.host"   /f >nul 2>&1
reg delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.videograbber.host" /f >nul 2>&1

echo [OK] VideoGrabber native host unregistered from all browsers.
echo You can now delete this folder and remove the extension from your browser.
pause
