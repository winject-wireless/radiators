// Entry points of the openEMS WebAssembly module (see ../js/openems.js).
//
// One module instance runs in one Web Worker. The worker calls these through
// ccall; files live in the in-memory file system (FS) of the instance.
//
//   oems_run(argc, argv)          openEMS <xml> [options...], like the openEMS binary
//   oems_nf2ff(xml)               nf2ff <xml>, like the nf2ff binary
//   oems_abort_flag()             address of an int: nonzero stops a running
//                                 simulation gracefully (results are written)
//   oems_h5_list(file)            newline separated "path<TAB>kind<TAB>rank<TAB>dims..."
//                                 of every dataset in an HDF5 file (malloc'd, free it);
//                                 kind is "r" (real) or "c" (complex: a compound of two
//                                 floats, as openEMS writes complex data)
//   oems_h5_read(file, path, out) dataset as doubles into out (size from h5_list;
//                                 complex data interleaved re, im: twice the size)
//   oems_h5_attr(file, path, name, out, max)  numeric attribute as doubles
//
// Copyright the radiators authors. Links openEMS / CSXCAD (GPLv3).

#include <emscripten/emscripten.h>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

#include <hdf5.h>
#include <hdf5_hl.h>

#include "openems.h"
#include "tools/global.h"
#include "nf2ff/nf2ff.h"

static std::atomic<int> g_abort_flag{0};

extern "C" {

EMSCRIPTEN_KEEPALIVE int *oems_abort_flag() { return reinterpret_cast<int *>(&g_abort_flag); }

EMSCRIPTEN_KEEPALIVE int oems_run(int argc, const char **argv)
{
	g_abort_flag.store(0);
	openEMS FDTD;
	openEMS::WelcomeScreen();
	if (argc <= 1)
	{
		FDTD.showUsage();
		return 2;
	}

	// The page sets the flag in shared memory; this thread hands it to openEMS,
	// which checks it between timesteps and then writes its results as usual.
	std::atomic<bool> done{false};
	std::thread watcher([&] {
		while (!done.load())
		{
			if (g_abort_flag.load())
			{
				FDTD.SetAbort(true);
				break;
			}
			std::this_thread::sleep_for(std::chrono::milliseconds(50));
		}
	});

	int rc = 0;
	try
	{
		g_settings.parseCommandLineArguments(argc, argv);
		if (!FDTD.ParseFDTDSetup(argv[1]))
		{
			std::cerr << "openEMS - ParseFDTDSetup failed." << std::endl;
			rc = 1;
		}
		else
		{
			rc = FDTD.SetupFDTD();
			if (rc == 0)
				FDTD.RunFDTD();
		}
	}
	catch (const std::exception &e)
	{
		std::cerr << "openEMS: Error: " << e.what() << std::endl;
		rc = 1;
	}
	done.store(true);
	watcher.join();
	std::cout << std::flush;
	std::cerr << std::flush;
	return rc;
}

EMSCRIPTEN_KEEPALIVE int oems_nf2ff(const char *xml)
{
	try
	{
		return nf2ff::AnalyseXMLFile(xml) ? 0 : 1;
	}
	catch (const std::exception &e)
	{
		std::cerr << "nf2ff: Error: " << e.what() << std::endl;
		return 1;
	}
}

// a compound of exactly two floating point members ({r, i} or {real, imag})
static bool is_complex(hid_t type)
{
	if (H5Tget_class(type) != H5T_COMPOUND || H5Tget_nmembers(type) != 2)
		return false;
	return H5Tget_member_class(type, 0) == H5T_FLOAT && H5Tget_member_class(type, 1) == H5T_FLOAT;
}

static herr_t list_cb(hid_t obj, const char *name, const H5O_info2_t *info, void *data)
{
	if (info->type != H5O_TYPE_DATASET)
		return 0;
	auto *out = static_cast<std::ostringstream *>(data);
	hid_t ds = H5Dopen2(obj, name, H5P_DEFAULT);
	if (ds < 0)
		return 0;
	hid_t sp = H5Dget_space(ds);
	int rank = H5Sget_simple_extent_ndims(sp);
	hsize_t dims[32] = {0};
	if (rank > 0 && rank <= 32)
		H5Sget_simple_extent_dims(sp, dims, nullptr);
	hid_t type = H5Dget_type(ds);
	*out << '/' << name << '\t' << (is_complex(type) ? 'c' : 'r') << '\t' << rank;
	H5Tclose(type);
	for (int i = 0; i < rank && i < 32; ++i)
		*out << '\t' << dims[i];
	*out << '\n';
	H5Sclose(sp);
	H5Dclose(ds);
	return 0;
}

EMSCRIPTEN_KEEPALIVE char *oems_h5_list(const char *file)
{
	hid_t f = H5Fopen(file, H5F_ACC_RDONLY, H5P_DEFAULT);
	if (f < 0)
		return nullptr;
	std::ostringstream out;
	H5Ovisit3(f, H5_INDEX_NAME, H5_ITER_NATIVE, list_cb, &out, H5O_INFO_BASIC);
	H5Fclose(f);
	return strdup(out.str().c_str());
}

EMSCRIPTEN_KEEPALIVE int oems_h5_read(const char *file, const char *path, double *out)
{
	hid_t f = H5Fopen(file, H5F_ACC_RDONLY, H5P_DEFAULT);
	if (f < 0)
		return -1;
	herr_t st = -1;
	hid_t ds = H5Dopen2(f, path, H5P_DEFAULT);
	if (ds >= 0)
	{
		hid_t type = H5Dget_type(ds);
		if (is_complex(type))
		{
			// read both members as doubles, by member name, into {re, im} pairs
			char *n0 = H5Tget_member_name(type, 0);
			char *n1 = H5Tget_member_name(type, 1);
			hid_t mem = H5Tcreate(H5T_COMPOUND, 2 * sizeof(double));
			H5Tinsert(mem, n0, 0, H5T_NATIVE_DOUBLE);
			H5Tinsert(mem, n1, sizeof(double), H5T_NATIVE_DOUBLE);
			st = H5Dread(ds, mem, H5S_ALL, H5S_ALL, H5P_DEFAULT, out);
			H5Tclose(mem);
			H5free_memory(n0);
			H5free_memory(n1);
		}
		else
			st = H5Dread(ds, H5T_NATIVE_DOUBLE, H5S_ALL, H5S_ALL, H5P_DEFAULT, out);
		H5Tclose(type);
		H5Dclose(ds);
	}
	H5Fclose(f);
	return st < 0 ? -1 : 0;
}

// Numeric attribute `name` of the object at `path`; returns its element count
// (copies at most `max`), or -1.
EMSCRIPTEN_KEEPALIVE int oems_h5_attr(const char *file, const char *path, const char *name, double *out, int max)
{
	hid_t f = H5Fopen(file, H5F_ACC_RDONLY, H5P_DEFAULT);
	if (f < 0)
		return -1;
	int n = -1;
	hid_t a = H5Aopen_by_name(f, path, name, H5P_DEFAULT, H5P_DEFAULT);
	if (a >= 0)
	{
		hid_t sp = H5Aget_space(a);
		hssize_t count = H5Sget_simple_extent_npoints(sp);
		H5Sclose(sp);
		if (count >= 0)
		{
			double *buf = static_cast<double *>(malloc(sizeof(double) * (count ? count : 1)));
			if (H5Aread(a, H5T_NATIVE_DOUBLE, buf) >= 0)
			{
				n = static_cast<int>(count);
				memcpy(out, buf, sizeof(double) * (n < max ? n : max));
			}
			free(buf);
		}
		H5Aclose(a);
	}
	H5Fclose(f);
	return n;
}

} // extern "C"
