#include <napi.h>
#include <string>

#ifdef __GLIBC__
#include <malloc.h>
#endif

#include "../shared.h"
#include "worker.h"

#if defined(WIN32) && defined(MAGICK_ENABLED)
#include <Magick++.h>
#endif
#include <vips/vips8>

#ifdef WITH_BACKWARD
#include "backward.hpp"

namespace backward {
  backward::SignalHandling sh;
}
#endif

using namespace std;

const string defaultType = "png";

Napi::Value ProcessMedia(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  string command = info[0].As<Napi::String>().Utf8Value();
  Napi::Object obj = info[1].As<Napi::Object>();
  Napi::Object input = info[2].As<Napi::Object>();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

  string type = input.Has("type") ? input.Get("type").As<Napi::String>().Utf8Value() : defaultType;

  esmb::ArgumentMap Arguments;

  // We only have a single possible global arg at the moment,
  // let's define it here
  auto val = obj.Get("togif");
  if (!val.IsEmpty() && !val.IsUndefined() && !val.IsNull()) {
    Arguments["togif"] = val.ToBoolean().Value();
  }

  if (MapContainsKey(esmb::Image::FunctionArgsMap, command)) {
    FunctionArgs *argTypes = esmb::Image::FunctionArgsMap.at(command);
    for (auto arg : *argTypes) {
      val = obj.Get(arg.first);
      if (val.IsEmpty() || val.IsUndefined() || val.IsNull()) continue;

      if (arg.second.type == typeid(bool)) {
        Arguments[arg.first] = val.ToBoolean().Value();
      } else if (arg.second.type == typeid(string)) {
        Arguments[arg.first] = val.ToString().As<Napi::String>().Utf8Value();
      } else if (arg.second.type == typeid(int)) {
        Arguments[arg.first] = val.ToNumber().Int32Value();
      } else if (arg.second.type == typeid(float)) {
        Arguments[arg.first] = val.ToNumber().FloatValue();
      } else {
        deferred.Reject(Napi::Error::New(env, "Type of property \"" + arg.first + "\" is unknown").Value());
        return deferred.Promise();
      }
    }
  }

  char *bufData = NULL;
  size_t bufSize = 0;
  if (input.Has("data")) {
    Napi::ArrayBuffer data = input.Get("data").As<Napi::ArrayBuffer>();
    bufData = (char *)data.Data();
    bufSize = data.ByteLength();
  }

  MediaAsyncWorker *asyncWorker = new MediaAsyncWorker(env, deferred, command, Arguments, type, bufData, bufSize);
  asyncWorker->Queue();
  return deferred.Promise();
}

/*
  This is a workaround for an issue in some libc implementations (e.g. glibc)
  where a multithreaded application with many heaps/arenas can hold on to large
  amounts of unused memory, never returning it back to the kernel automatically.

  Without this, memory usage can balloon over time to multiple gigabytes when idle -
  despite none of it being used for anything at all, not even caching.

  See this related discussion in the glibc mailing list:
  https://sourceware.org/pipermail/libc-help/2020-September/005457.html
*/
Napi::Value Trim(const Napi::CallbackInfo &info) {
#ifdef __GLIBC__
  int res = malloc_trim(0);
  return Napi::Number::From(info.Env(), res);
#else
  return Napi::Number::From(info.Env(), 0);
#endif
}

Napi::Value MediaInit(const Napi::CallbackInfo &info) {
#if __GLIBC__
  /*
    Set mmap threshold to 128kb to work around a similar glibc bug to the one above.
    (Or maybe the same one?)

    The following "fix" (along with malloc_trim) has been used in projects such as KWin, GIMP,
    and Nautilus for years, with COSMIC also finding and implementing this somewhat more recently.
    More info here from a COSMIC dev: https://fosstodon.org/@mmstick/113952008189644564
  */
  mallopt(M_MMAP_THRESHOLD, 131072);
#endif

#if defined(WIN32) && defined(MAGICK_ENABLED)
  Magick::InitializeMagick("");
#endif

  if (VIPS_INIT("")) vips_error_exit(NULL);
  vips_cache_set_max(0);

#if VIPS_MAJOR_VERSION > 8 || (VIPS_MAJOR_VERSION == 8 && VIPS_MINOR_VERSION >= 13)
  vips_block_untrusted_set(true);
  vips_operation_block_set("VipsForeignLoad", true);
  vips_operation_block_set("VipsForeignLoadJpeg", false);
  vips_operation_block_set("VipsForeignLoadPng", false);
  vips_operation_block_set("VipsForeignLoadNsgif", false);
  vips_operation_block_set("VipsForeignLoadWebp", false);
  vips_operation_block_set("VipsForeignLoadHeif", false);
#endif

  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "process"), Napi::Function::New(env, ProcessMedia));
  exports.Set(Napi::String::New(env, "init"), Napi::Function::New(env, MediaInit));
  exports.Set(Napi::String::New(env, "trim"), Napi::Function::New(env, Trim));

  size_t i = 0;

  Napi::Array funcs = Napi::Array::New(env);
  for (auto const &imap : esmb::Image::FunctionMap) {
    Napi::HandleScope scope(env);
    Napi::Object func = Napi::Object::New(env);
    func.Set("name", Napi::String::New(env, imap.first));
    func.Set("input", Napi::Boolean::From(env, true));
    func.Set("anim", Napi::Boolean::From(env, std::count(esmb::Image::AnimFunctions.begin(),
                                                         esmb::Image::AnimFunctions.end(), imap.first) > 0));
    funcs[i] = func;
    i++;
  }
  for (auto const &imap : esmb::Image::NoInputFunctionMap) {
    Napi::HandleScope scope(env);
    Napi::Object func = Napi::Object::New(env);
    func.Set("name", Napi::String::New(env, imap.first));
    func.Set("input", Napi::Boolean::From(env, false));
    funcs[i] = func;
    i++;
  }
  exports.Set(Napi::String::New(env, "funcs"), funcs);

  return exports;
}

NODE_API_MODULE(addon, Init)
