#import <Foundation/Foundation.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

// Keep this layout in sync with raw.rs. The caller owns pixels after success
// and releases them only through goop_raw_free, never a different allocator.
typedef struct {
    uint32_t width;
    uint32_t height;
    uint8_t *pixels;
    size_t length;
    char error[512];
} GoopRawResult;

static BOOL valid_size(double width, double height) {
    return isfinite(width) && isfinite(height) && width >= 1 && height >= 1
        && width <= 32768 && height <= 32768
        && floor(width) == width && floor(height) == height
        && width * height <= 100000000;
}

void goop_raw_free(uint8_t *pixels) { free(pixels); }

// The RAW filter uses the primary sensor/linear DNG image, with Apple's default
// camera processing. ImageIO is metadata-only here: no thumbnail/preview API.
int goop_raw_read(const char *path, int decode, GoopRawResult *result) {
    @autoreleasepool {
        CGImageSourceRef source = NULL;
        CGColorSpaceRef colorSpace = NULL;
        CGImageRef rendered = NULL;
        CGContextRef bitmap = NULL;
        uint8_t *pixels = NULL;
        int success = 0;
        @try {
            NSURL *url = [NSURL fileURLWithFileSystemRepresentation:path
                                                       isDirectory:NO relativeToURL:nil];
            NSDictionary *sourceOptions = @{(__bridge NSString *)kCGImageSourceShouldCache: @NO};
            source = CGImageSourceCreateWithURL((__bridge CFURLRef)url,
                                                (__bridge CFDictionaryRef)sourceOptions);
            if (!source) {
                snprintf(result->error, sizeof(result->error), "Cannot read RAW file.");
                return 0;
            }
            NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(
                source, 0, (__bridge CFDictionaryRef)sourceOptions));
            if (!properties[(__bridge NSString *)kCGImagePropertyDNGDictionary]
                && !properties[(__bridge NSString *)kCGImagePropertyRawDictionary]) {
                snprintf(result->error, sizeof(result->error), "File is not a supported camera RAW image.");
                return 0;
            }
            // Use the original RAW API to retain the existing deployment floor.
            // The filter applies the file's EXIF orientation; never apply it again.
            CIFilter *filter = [CIFilter filterWithImageURL:url options:@{
                kCIInputAllowDraftModeKey: @NO,
                kCIInputScaleFactorKey: @1.0,
                kCIInputIgnoreImageOrientationKey: @NO
            }];
            if (!filter) {
                snprintf(result->error, sizeof(result->error),
                    "macOS cannot decode this camera RAW file. Update macOS or export it as TIFF or PNG in Photos.");
                return 0;
            }
            // Explicitly disable extended-range RAW output where supported.
            if (@available(macOS 10.14, *)) {
                [filter setValue:@NO forKey:kCIInputEnableEDRModeKey];
            }
            CIVector *nativeSize = [filter valueForKey:kCIOutputNativeSizeKey];
            if (!nativeSize || !valid_size(nativeSize.X, nativeSize.Y)) {
                snprintf(result->error, sizeof(result->error), "RAW dimensions exceed the 100 megapixel / 32768 pixel safety limit.");
                return 0;
            }
            CIImage *image = filter.outputImage;
            CGRect bounds = image.extent;
            if (!image || !valid_size(bounds.size.width, bounds.size.height)
                || !isfinite(bounds.origin.x) || !isfinite(bounds.origin.y)) {
                snprintf(result->error, sizeof(result->error), "RAW renderer returned invalid image dimensions.");
                return 0;
            }
            result->width = (uint32_t)bounds.size.width;
            result->height = (uint32_t)bounds.size.height;
            if (!decode) return 1;

            colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
            if (!colorSpace) {
                snprintf(result->error, sizeof(result->error), "Cannot create sRGB color space.");
                return 0;
            }
            CIContext *context = [CIContext contextWithOptions:@{
                kCIContextOutputColorSpace: (__bridge id)colorSpace,
                kCIContextCacheIntermediates: @NO
            }];
            // Explicit non-extended sRGB and 8-bit output flatten to SDR.
            rendered = [context createCGImage:image fromRect:bounds format:kCIFormatRGBA8 colorSpace:colorSpace deferred:NO];
            if (!rendered) {
                snprintf(result->error, sizeof(result->error), "macOS failed to render primary RAW pixels.");
                return 0;
            }
            size_t rowBytes = (size_t)result->width * 4;
            result->length = rowBytes * result->height;
            pixels = calloc(1, result->length);
            if (!pixels) {
                snprintf(result->error, sizeof(result->error), "Insufficient memory for RAW pixels.");
                return 0;
            }
            bitmap = CGBitmapContextCreate(pixels, result->width, result->height, 8, rowBytes,
                colorSpace, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
            if (!bitmap) {
                snprintf(result->error, sizeof(result->error), "Cannot allocate RAW bitmap context.");
                return 0;
            }
            CGContextDrawImage(bitmap, CGRectMake(0, 0, result->width, result->height), rendered);
            result->pixels = pixels;
            success = 1;
        } @catch (NSException *exception) {
            snprintf(result->error, sizeof(result->error), "macOS RAW renderer failed: %s",
                exception.reason.UTF8String ?: "unknown native exception");
        } @finally {
            if (bitmap) CGContextRelease(bitmap);
            if (rendered) CGImageRelease(rendered);
            if (colorSpace) CGColorSpaceRelease(colorSpace);
            if (source) CFRelease(source);
            if (!success) free(pixels);
        }
        return success;
    }
}
