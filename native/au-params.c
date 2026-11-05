// Lists an Audio Unit's parameters and ranges, for PLUG-IN's knob positions (src/fl/auParams.ts).
// FL's script API can't give them, and an Audio Unit may print to stdout or crash, so this runs in its own
// process. It makes one instance of the plug-in, with no audio and no window, in the order FL's Audio Unit
// wrapper uses: kAudioUnitProperty_ParameterList, then ParameterInfo for each (docs/fl-api-notes.md).
//
//   au-params "<plug-in name>"
//
// One line per parameter: name, minimum, maximum, separated by tabs. Exit 2: no Audio Unit of that name.
// Exit 3: it wouldn't open. Built on first use by mk3d, with cc.
#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static AudioComponent find_component(const char *wanted) {
  CFStringRef want = CFStringCreateWithCString(NULL, wanted, kCFStringEncodingUTF8);
  if (!want) return NULL;
  AudioComponentDescription any = {0, 0, 0, 0, 0};
  AudioComponent component = NULL;
  while ((component = AudioComponentFindNext(component, &any))) {
    CFStringRef name = NULL;
    if (AudioComponentCopyName(component, &name) != noErr || !name) continue;
    // "Vendor: Plug-in"; FL shows the part after the vendor.
    CFArrayRef parts = CFStringCreateArrayBySeparatingStrings(NULL, name, CFSTR(": "));
    CFStringRef last = CFArrayGetValueAtIndex(parts, CFArrayGetCount(parts) - 1);
    Boolean same = CFStringCompare(last, want, 0) == kCFCompareEqualTo;
    CFRelease(parts);
    CFRelease(name);
    if (same) return component;
  }
  return NULL;
}

static UInt32 parameter_ids(AudioUnit unit, AudioUnitParameterID **ids) {
  UInt32 size = 0;
  Boolean writable;
  if (AudioUnitGetPropertyInfo(unit, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, &size,
                               &writable) != noErr || size == 0)
    return 0;
  *ids = malloc(size);
  if (!*ids || AudioUnitGetProperty(unit, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, *ids,
                                    &size) != noErr)
    return 0;
  return size / sizeof(AudioUnitParameterID);
}

int main(int argc, char **argv) {
  if (argc != 2) return 1;
  // Plug-ins print to stdout: only this file's lines may reach the real one.
  int fd = dup(1);
  int null = open("/dev/null", O_WRONLY);
  if (fd < 0 || null < 0) return 1;
  dup2(null, 1);
  FILE *out = fdopen(fd, "w");
  if (!out) return 1;

  AudioComponent component = find_component(argv[1]);
  if (!component) return 2;
  AudioUnit unit = NULL;
  if (AudioComponentInstanceNew(component, &unit) != noErr || !unit) return 3;

  AudioUnitParameterID *ids = NULL;
  UInt32 count = parameter_ids(unit, &ids);
  if (count == 0 && AudioUnitInitialize(unit) == noErr) count = parameter_ids(unit, &ids);
  for (UInt32 i = 0; i < count; i++) {
    AudioUnitParameterInfo info;
    UInt32 size = sizeof info;
    memset(&info, 0, sizeof info);
    char name[64] = "";
    if (AudioUnitGetProperty(unit, kAudioUnitProperty_ParameterInfo, kAudioUnitScope_Global, ids[i], &info,
                             &size) != noErr) {
      fprintf(out, "\t0\t0\n"); // keeps the line numbers equal to FL's parameter indexes
      continue;
    }
    if ((info.flags & kAudioUnitParameterFlag_HasCFNameString) && info.cfNameString)
      CFStringGetCString(info.cfNameString, name, 52, kCFStringEncodingUTF8);
    else
      strlcpy(name, info.name, 52);
    for (char *c = name; *c; c++)
      if ((unsigned char)*c < 0x20) *c = ' ';
    fprintf(out, "%s\t%g\t%g\n", name, info.minValue, info.maxValue);
  }
  fflush(out);
  _exit(0); // no teardown: the plug-in's own can only go wrong
}
